const lncli = require('ln-service');
const bolt11 = require("bolt11");
const bigDecimal = require("js-big-decimal");
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const web3 = require("@solana/web3.js");
//const spl_token = require("@solana/spl-token");
const nacl = require("tweetnacl");
const anchor = require("@project-serum/anchor");
const programIdl = require("./programIdl");
const crypto = require("crypto");

const {_client, _signer, address, lnd, GRACE_PERIOD, SAFETY_FACTOR, AUTHORIZATION_TIMEOUT, BITCOIN_BLOCKTIME, BASE_FEE, FEE, WBTC_ADDRESS, CHAIN_ID, AUTHORITY_SEED, USER_VAULT_SEED, VAULT_SEED, STATE_SEED} = require("./constants");

const MIN_LNSEND_CTLV = new bigDecimal(10);
const MIN_LNSEND_TS_DELTA = GRACE_PERIOD.add(BITCOIN_BLOCKTIME.multiply(MIN_LNSEND_CTLV).multiply(SAFETY_FACTOR));

const MIN_AMOUNT = new bigDecimal(1000);
const MAX_AMOUNT = new bigDecimal(1000000);

const program = new anchor.Program(programIdl, programIdl.metadata.address, _client);

const vaultAuthorityKey = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(AUTHORITY_SEED)],
    program.programId
)[0];

const vaultKey = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_SEED), WBTC_ADDRESS.toBuffer()],
    program.programId
)[0];

const userVaultKey = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(USER_VAULT_SEED), _signer.publicKey.toBuffer(), WBTC_ADDRESS.toBuffer()],
    program.programId
)[0];

//Param: hash - Buffer
function getEscrowStateKey(hash) {
    return web3.PublicKey.findProgramAddressSync(
        [Buffer.from(STATE_SEED), hash],
        program.programId
    )[0];
}

const dirName = "soltobtcln";

const invoices = {};

async function removeInvoiceData(paymentHash) {
    try {
        if(invoices[paymentHash]!=null) delete invoices[paymentHash];
        await fs.rm(dirName+"/"+paymentHash+".json");
    } catch (e) {
        console.error(e);
    }
}

async function saveInvoiceData(paymentHash, obj) {
    try {
        await fs.mkdir(dirName)
    } catch (e) {}

    invoices[paymentHash] = obj;

    const cpy = {...obj};

    if(cpy.offerer!=null) {
        cpy.offerer = obj.offerer.toBase58();
    }
    if(cpy.swapFee!=null) {
        cpy.swapFee = obj.swapFee.getValue();
    }
    if(cpy.data!=null) {
        cpy.data = {
            initializer: obj.data.initializer.toBase58(),
            intermediary: obj.data.intermediary.toBase58(),
            token: obj.data.token.toBase58(),
            amount: obj.data.amount.getValue(),
            paymentHash: obj.data.paymentHash,
            expiry: obj.data.expiry.getValue()
        };
    }

    await fs.writeFile(dirName+"/"+paymentHash+".json", JSON.stringify(cpy));
}

async function loadInvoiceData() {
    let files;
    try {
        files = await fs.readdir(dirName);
    } catch (e) {
        console.error(e);
        return [];
    }

    const arr = [];

    for(let file of files) {
        const result = await fs.readFile(dirName+"/"+file);
        const obj = JSON.parse(result.toString());
        if(obj.offerer!=null) {
            obj.offerer = new web3.PublicKey(obj.offerer);
        }
        if(obj.swapFee!=null) {
            obj.swapFee = new bigDecimal(obj.swapFee);
        }
        if(obj.data!=null) {
            obj.data.initializer = new web3.PublicKey(obj.data.initializer);
            obj.data.intermediary = new web3.PublicKey(obj.data.intermediary);
            obj.data.token = new web3.PublicKey(obj.data.token);
            obj.data.expiry = new bigDecimal(obj.data.expiry);
            obj.data.amount = new bigDecimal(obj.data.amount);
        }
        arr.push(obj);
    }

    return arr;
}

async function processPaymentResult(lnPr, offerer, data, lnPaymentStatus) {
    const decodedPR = bolt11.decode(lnPr);

    if(lnPaymentStatus.is_failed) {
        console.error("[SOL->BTCLN: SOL.PaymentRequest] Invoice payment failed, should refund offerer");
        await removeInvoiceData(decodedPR.tagsObject.payment_hash);
        return;
    }

    if(lnPaymentStatus.is_pending) {
        return;
    }

    if(lnPaymentStatus.is_confirmed) {

        //Check if escrow state exists
        const escrowStateKey = getEscrowStateKey(Buffer.from(decodedPR.tagsObject.payment_hash, "hex"));

        try {
            const escrowState = await program.account.escrowState.fetch(escrowStateKey);
            if(escrowState==null) throw new Error("Escrow doesn't exist");
        } catch (e) {
            console.error(e);
            console.error("[SOL->BTCLN: SOL.claimer_claim] Tried to claim but escrow doesn't exist anymore: ", decodedPR.tagsObject.payment_hash);
            return;
        }

        let result = await program.methods
            .claimerClaim(Buffer.from(lnPaymentStatus.payment.secret, "hex"))
            .accounts({
                claimer: _signer.publicKey,
                offerer: offerer,
                initializer: data.initializer,
                userData: userVaultKey,
                escrowState: escrowStateKey,
                systemProgram: web3.SystemProgram.programId,
                ixSysvar: web3.SYSVAR_INSTRUCTIONS_PUBKEY
            })
            .signers([_signer])
            .transaction();

        const signature = await _client.sendAndConfirm(result, [_signer]);

        console.log("[SOL->BTCLN: SOL.claimer_claim] Transaction sent: ", signature);
        return;

    }

    throw new Error("Invalid lnPaymentStatus");
}

async function loadSOLtoBTCLN() {

    const loadedInvoices = await loadInvoiceData();

    for(let invoiceData of loadedInvoices) {
        const decodedPR = bolt11.decode(invoiceData.pr);
        invoices[decodedPR.tagsObject.payment_hash] = invoiceData;
    }

}

async function checkPastInvoices() {

    for(let key in invoices) {
        const invoiceData = invoices[key];
        const decodedPR = bolt11.decode(invoiceData.pr);

        if(invoiceData.state===0) {
            //Yet unpaid
            if(decodedPR.timeExpireDate<Date.now()/1000) {
                //Expired
                await removeInvoiceData(decodedPR.tagsObject.payment_hash);
                continue;
            }
        }

        if(invoiceData.state===1) {
            //Payment should've or already begun
            //invoices[decodedPR.tagsObject.payment_hash] = invoiceData;
            await processSOLtoBTCLN(invoiceData, invoiceData.offerer, invoiceData.data);
            //continue;
        }

        /*if(invoiceData.state===2) {
            //Claim transaction created/signed maybe also broadcasted and confirmed
            invoices[decodedPR.tagsObject.payment_hash] = invoiceData;
            try {
                const res = await _client.sendTransaction(invoiceData.signedTx);
                console.log("[SOL->BTCLN: SOL.claimer_claim] Transaction sent: ", res);
            } catch (e) {
                console.error(e);
            }
        }*/
    }

}

const activeSubscriptions = new Set();

function subscribeToPayment(lnPr, offerer, data) {
    const decodedPR = bolt11.decode(lnPr);
    if(activeSubscriptions.has(decodedPR.tagsObject.payment_hash)) {
        return;
    }

    const sub = lncli.subscribeToPastPayment({id: decodedPR.tagsObject.payment_hash, lnd});

    console.log("Subscribed to payment: ", decodedPR.tagsObject.payment_hash);

    sub.on('confirmed', (payment) => {
        const lnPaymentStatus = {
            is_confirmed: true,
            payment
        };

        console.log("[SOL->BTCLN: SOL.PaymentRequest] Invoice paid, result: ", payment);

        processPaymentResult(lnPr, offerer, data, lnPaymentStatus);

        sub.removeAllListeners();
        activeSubscriptions.delete(decodedPR.tagsObject.payment_hash);
    });

    sub.on('failed', (payment) => {
        const lnPaymentStatus = {
            is_failed: true
        };

        console.log("[SOL->BTCLN: SOL.PaymentRequest] Invoice pay failed, result: ", payment);

        processPaymentResult(lnPr, offerer, data, lnPaymentStatus);

        sub.removeAllListeners();
        activeSubscriptions.delete(decodedPR.tagsObject.payment_hash);
    });

    activeSubscriptions.add(decodedPR.tagsObject.payment_hash);
}

async function processSOLtoBTCLN(invoiceData, offerer, data) {

    const lnPr = invoiceData.pr;
    const decodedPR = bolt11.decode(lnPr);

    //Check if payment was already made
    let lnPaymentStatus = await lncli.getPayment({
        id: decodedPR.tagsObject.payment_hash,
        lnd
    }).catch(e => {
        console.error(e);
    });

    if(lnPaymentStatus==null) {
        const tokenAddress = data.token;

        if(!tokenAddress.equals(WBTC_ADDRESS)) {
            console.error("[SOL->BTCLN: SOL.PaymentRequest] Invalid token used");
            return;
        }

        console.log("[SOL->BTCLN: SOL.PaymentRequest] Struct: ", data);

        const tokenAmount = data.amount;

        const expiryTimestamp = data.expiry;
        const currentTimestamp = new bigDecimal(Date.now()/1000);

        console.log("[SOL->BTCLN: SOL.PaymentRequest] Expiry time: ", expiryTimestamp.getValue());

        if(expiryTimestamp.subtract(currentTimestamp).compareTo(MIN_LNSEND_TS_DELTA)<0) {
            console.error("[SOL->BTCLN: SOL.PaymentRequest] Not enough time to reliably pay the invoice");
            return;
        }

        console.log("[SOL->BTCLN: SOL.PaymentRequest] lightning payment request: ", lnPr);

        console.log("[SOL->BTCLN: SOL.PaymentRequest] Decoded lightning payment request: ", decodedPR);

        if(decodedPR.satoshis==null) {
            console.error("[SOL->BTCLN: SOL.PaymentRequest] Invalid invoice with amount");
            return;
        }

        const amountBD = new bigDecimal(decodedPR.satoshis);

        if(amountBD.compareTo(MIN_AMOUNT)<0) {
            console.error("[SOL->BTCLN: SOL.PaymentRequest] Low payment amount: "+amountBD.getValue()+" minimum: "+MIN_AMOUNT.getValue());
            return;
        }
        if(amountBD.compareTo(MAX_AMOUNT)>0) {
            console.error("[SOL->BTCLN: SOL.PaymentRequest] High payment amount: "+amountBD.getValue()+" maximum: "+MAX_AMOUNT.getValue());
            return;
        }

        const maxFee = amountBD.subtract(invoiceData.swapFee);

        console.log("[SOL->BTCLN: SOL.PaymentRequest] Invoice amount: ", amountBD.getValue());
        console.log("[SOL->BTCLN: SOL.PaymentRequest] Token amount: ", tokenAmount.getValue());

        if(maxFee.compareTo(new bigDecimal(0))<0) {
            console.error("[SOL->BTCLN: SOL.PaymentRequest] Not enough paid!");
            return;
        }

        const maxUsableCLTV = expiryTimestamp.subtract(currentTimestamp).subtract(GRACE_PERIOD).divide(BITCOIN_BLOCKTIME.multiply(SAFETY_FACTOR)).floor();

        console.log("[SOL->BTCLN: SOL.PaymentRequest] Max usable CLTV expiry: ", maxUsableCLTV.getValue());
        console.log("[SOL->BTCLN: SOL.PaymentRequest] Max fee: ", maxFee.getValue());

        await saveInvoiceData(decodedPR.tagsObject.payment_hash, {
            state: 1,
            pr: lnPr,
            swapFee: invoiceData.swapFee,
            offerer,
            data
        });

        const { current_block_height } = await lncli.getHeight({lnd});

        const obj = {
            request: lnPr,
            max_fee: maxFee.getValue(),
            max_timeout_height: new bigDecimal(current_block_height).add(maxUsableCLTV).getValue()
        };

        console.log("[SOL->BTCLN: SOL.PaymentRequest] Paying invoice with: ", obj);

        obj.lnd = lnd;

        const payment = await lncli.pay(obj).catch(e => {
            console.error(e);
        });

        subscribeToPayment(lnPr, offerer, data);
        return;
    }

    if(lnPaymentStatus.is_pending) {
        subscribeToPayment(lnPr, offerer, data);
        return;
    }

    await processPaymentResult(lnPr, offerer, data, lnPaymentStatus);

}

async function setupSOLtoBTCLN() {

    await checkPastInvoices();

    const app = express();

    app.use(cors());
    app.use(express.json());

    app.post('/payInvoice', async function (req, res) {
        if (
            req.body == null ||

            req.body.pr == null ||
            typeof(req.body.pr) !== "string" ||

            req.body.maxFee == null ||
            typeof(req.body.maxFee) !== "string" ||

            req.body.expiryTimestamp == null ||
            typeof(req.body.expiryTimestamp) !== "string"
        ) {
            res.status(400).json({
                msg: "Invalid request body (pr/maxFee/expiryTimestamp)"
            });
            return;
        }

        let maxFeeBD;

        try {
            maxFeeBD = new bigDecimal(req.body.maxFee);
        } catch (e) {
            res.status(400).json({
                msg: "Invalid request body (maxFee - cannot be parsed)"
            });
            return;
        }

        const currentTimestamp = new bigDecimal(Date.now()/1000);
        let expiryTimestamp;

        try {
            expiryTimestamp = new bigDecimal(req.body.expiryTimestamp)
        } catch (e) {
            res.status(400).json({
                msg: "Invalid request body (expiryTimestamp - cannot be parsed)"
            });
            return;
        }

        let parsedPR;

        try {
            parsedPR = bolt11.decode(req.body.pr)
        } catch (e) {
            res.status(400).json({
                msg: "Invalid request body (pr - cannot be parsed)"
            });
            return;
        }

        if(parsedPR.timeExpireDate < Date.now()/1000) {
            res.status(400).json({
                msg: "Invalid request body (pr - expired)"
            });
            return;
        }

        if(expiryTimestamp.subtract(currentTimestamp).compareTo(MIN_LNSEND_TS_DELTA)<0) {
            res.status(400).json({
                code: 20001,
                msg: "Expiry time too low!"
            });
            return;
        }

        const amountBD = new bigDecimal(parsedPR.satoshis);

        if(amountBD.compareTo(MIN_AMOUNT)<0) {
            res.status(400).json({
                code: 20003,
                msg: "Amount too low!",
                data: {
                    min: MIN_AMOUNT.getValue(),
                    max: MAX_AMOUNT.getValue()
                }
            });
            return;
        }
        if(amountBD.compareTo(MAX_AMOUNT)>0) {
            res.status(400).json({
                code: 20004,
                msg: "Amount too high!",
                data: {
                    min: MIN_AMOUNT.getValue(),
                    max: MAX_AMOUNT.getValue()
                }
            });
            return;
        }

        try {
            const payment = await lncli.getPayment({
                lnd,
                id: parsedPR.tagsObject.payment_hash
            });

            console.log(payment);

            if(payment!=null) {
                res.status(400).json({
                    code: 20010,
                    msg: "Already processed"
                });
                return;
            }
        } catch (e) {}

        console.log("Expiry delay (second): ", expiryTimestamp.subtract(currentTimestamp).getValue());

        const maxUsableCLTV = expiryTimestamp.subtract(currentTimestamp).subtract(GRACE_PERIOD).divide(BITCOIN_BLOCKTIME.multiply(SAFETY_FACTOR)).floor();

        const { current_block_height } = await lncli.getHeight({lnd});

        let obj;
        try {
            const parsedRequest = await lncli.parsePaymentRequest({
                request: req.body.pr
            });

            const probeReq = {
                destination: parsedPR.payeeNodeKey,
                cltv_delta: parsedPR.tagsObject.min_final_cltv_expiry,
                mtokens: parsedPR.millisatoshis,
                max_fee_mtokens: maxFeeBD.multiply(new bigDecimal(1000)).getValue(),
                max_timeout_height: new bigDecimal(current_block_height).add(maxUsableCLTV).getValue(),
                payment: parsedRequest.payment,
                total_mtokens: parsedPR.millisatoshis,
                routes: parsedRequest.routes
            };
            //if(hints.length>0) req.routes = [hints];
            console.log("Req: ", probeReq);
            probeReq.lnd = lnd;
            obj = await lncli.probeForRoute(probeReq);
        } catch (e) {
            console.log(e);
        }

        console.log("Probe result: ", obj);

        if(obj==null || obj.route==null) {
            res.status(400).json({
                code: 20002,
                msg: "Cannot route the payment!"
            });
            return;
        }

        const swapFee = amountBD.multiply(FEE).add(BASE_FEE).ceil();

        await saveInvoiceData(parsedPR.tagsObject.payment_hash, {
            state: 0,
            pr: req.body.pr,
            swapFee: swapFee
        });

        res.status(200).json({
            code: 20000,
            msg: "Success",
            data: {
                swapFee: swapFee.getValue(),
                total: amountBD.add(maxFeeBD).add(swapFee).getValue(),
                confidence: new bigDecimal(obj.route.confidence).divide(new bigDecimal(1000000), 6).getValue(),
                address
            }
        });

    });

    app.post('/getRefundAuthorization', async function (req, res) {
        if (
            req.body == null ||

            req.body.paymentHash == null ||
            typeof(req.body.paymentHash) !== "string"
        ) {
            res.status(400).json({
                msg: "Invalid request body (paymentHash)"
            });
            return;
        }

        const payment = await lncli.getPayment({
            id: req.body.paymentHash,
            lnd
        }).catch(err => {
            console.error(err);
        });

        if(payment==null) {
            res.status(200).json({
                code: 20007,
                msg: "Payment not found"
            });
            return;
        }

        if(payment.is_pending) {
            res.status(200).json({
                code: 20008,
                msg: "Payment in-flight"
            });
            return;
        }

        if(payment.is_confirmed) {
            res.status(200).json({
                code: 20006,
                msg: "Already paid",
                data: {
                    secret: payment.payment.secret
                }
            });
            return;
        }

        if(payment.is_failed) {
            const hash = Buffer.from(req.body.paymentHash, "hex");
            const escrowStateKey = getEscrowStateKey(hash);

            let escrowState;
            try {
                escrowState = await program.account.escrowState.fetch(escrowStateKey);
                if(escrowState==null) throw new Error("Escrow doesn't exist");
            } catch (e) {
                console.error(e);
                res.status(400).json({
                    code: 20005,
                    msg: "Not committed"
                });
                return;
            }

            const authPrefix = "refund";
            const authTimeout = Math.floor(Date.now()/1000)+AUTHORIZATION_TIMEOUT;

            const messageBuffers = [
                null,
                Buffer.alloc(8),
                Buffer.alloc(8),
                null,
                Buffer.alloc(8)
            ];

            messageBuffers[0] = Buffer.from("refund", "ascii");
            messageBuffers[1].writeBigUInt64LE(BigInt(escrowState.initializerAmount.toString(10)));
            messageBuffers[2].writeBigUInt64LE(BigInt(escrowState.expiry.toString(10)));
            messageBuffers[3] = hash;
            messageBuffers[4].writeBigUInt64LE(BigInt(authTimeout));

            const messageBuffer = Buffer.concat(messageBuffers);

            const signature = nacl.sign.detached(messageBuffer, _signer.secretKey);

            res.status(200).json({
                code: 20000,
                msg: "Success",
                data: {
                    address,
                    prefix: authPrefix,
                    timeout: authTimeout.toString(),
                    signature: Buffer.from(signature).toString("hex")
                }
            });
            return;
        }

        res.status(500).json({
            code: 20009,
            msg: "Invalid payment status"
        });
    });

    app.listen(4001);

    console.log("[SOL->BTCLN: Webserver] running on port 4001");

}

//const requestFilter = contractSOLtoBTCLN.filters.PaymentRequest(null, address);
//const claimFilterSOLtoBTCLN = contractSOLtoBTCLN.filters.Claimed(null, address);

async function processLogSOLtoBTCLN({events, instructions}) {

    for(let event of events) {
        if(event.name==="ClaimEvent") {
            const secret = Buffer.from(event.data.secret);

            const paymentHash = crypto.createHash("sha256").update(secret).digest().toString("hex");

            const savedInvoice = invoices[paymentHash];

            if(savedInvoice==null) {
                console.error("[SOL->BTCLN: SOL.claimer_claim] No invoice submitted");
                continue;
            }

            console.log("[SOL->BTCLN: SOL.claimer_claim] Transaction confirmed! Event: ", event);

            await removeInvoiceData(paymentHash);
        }
    }

    for(let ix of instructions) {
        if (ix == null) continue;

        if (
            (ix.name === "offererInitializePayIn" || ix.name === "offererInitialize") &&
            ix.accounts.claimer.equals(_signer.publicKey)
        ) {
            if(ix.data.kind!==0) {
                //Only process ln requests
                continue;
            }

            const paymentHash = Buffer.from(ix.data.hash).toString("hex");

            const savedInvoice = invoices[paymentHash];

            if(savedInvoice==null) {
                console.error("[SOL->BTCLN: SOL.PaymentRequest] No invoice submitted");
                continue;
            }

            console.error("[SOL->BTCLN: SOL.PaymentRequest] SOL request submitted");

            let offerer;
            if(ix.name === "offererInitializePayIn") {
                offerer = ix.accounts.initializer;
            } else {
                offerer = ix.accounts.offerer;
            }

            await processSOLtoBTCLN(savedInvoice, offerer, {
                initializer: ix.accounts.initializer,
                intermediary: ix.accounts.claimer,
                token: ix.accounts.mint,
                amount: new bigDecimal(ix.data.initializerAmount.toString(10)),
                paymentHash: Buffer.from(ix.data.hash).toString("hex"),
                expiry: new bigDecimal(ix.data.expiry.toString(10))
            });

        }
    }
}

module.exports = {
    setupSOLtoBTCLN,
    processLogSOLtoBTCLN,
    loadSOLtoBTCLN
}