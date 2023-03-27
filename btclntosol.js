const lncli = require('ln-service');
const programIdl = require("./programIdl");
const bigDecimal = require("js-big-decimal");
const express = require('express');
const cors = require('cors');
const anchor = require("@project-serum/anchor");
const fs = require('fs').promises;
const web3 = require("@solana/web3.js");
//const spl_token = require("@solana/spl-token");
const nacl = require("tweetnacl");
const crypto = require("crypto");
const {loadNonce, saveNonce, getNonce} = require("./nonce");

const {MAX_SOL_SKEW, _client, _signer, address, lnd, BITCOIN_BLOCKTIME, SAFETY_FACTOR, GRACE_PERIOD, AUTHORIZATION_TIMEOUT, WBTC_ADDRESS, FEE, BASE_FEE, STATE_SEED, AUTHORITY_SEED, USER_VAULT_SEED, VAULT_SEED} = require("./constants");

const HEX_REGEX = /[0-9a-fA-F]+/;

const MIN_LNRECEIVE_CTLV = new bigDecimal(20);

const MIN_AMOUNT_BTCLNtoSOL = new bigDecimal(1000);
const MAX_AMOUNT_BTCLNtoSOL = new bigDecimal(1000000);

const REFUND_CHECK_INTERVAL = 15*60*1000;

const program = new anchor.Program(programIdl, programIdl.metadata.address, _client);

const dirName = "btclntosol";

const swaps = {};

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

async function removeSwapData(paymentHash) {
    try {
        if(swaps[paymentHash]!=null) delete swaps[paymentHash];
        await fs.rm(dirName+"/"+paymentHash+".json");
    } catch (e) {
        console.error(e);
    }
}

async function saveSwapData(obj) {
    try {
        await fs.mkdir(dirName)
    } catch (e) {}

    const paymentHash = obj.paymentHash;

    swaps[paymentHash] = obj;

    const cpy = {...obj};
    cpy.intermediary = obj.intermediary.toBase58();
    cpy.token = obj.token.toBase58();
    cpy.amount = obj.amount.getValue();
    cpy.expiry = obj.expiry.getValue();

    await fs.writeFile(dirName+"/"+paymentHash+".json", JSON.stringify(cpy));
}

async function loadSwapData() {
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
        obj.intermediary = new web3.PublicKey(obj.intermediary);
        obj.token = new web3.PublicKey(obj.token);
        obj.expiry = new bigDecimal(obj.expiry);
        obj.amount = new bigDecimal(obj.amount);
        arr.push(obj);
    }

    return arr;
}

async function loadBTCLNtoSOL() {

    const arr = await loadSwapData();

    for(let obj of arr) {
        swaps[obj.paymentHash] = obj;
    }

    await loadNonce();
}

async function setupBTCLNtoSOLRefunder() {

    async function execute() {
        console.log("[BTCLN->SOL: SOL.CheckRefunds] Checking possible refunds...");

        //Check expiration on swaps
        const cancelInvoices = [];
        const refundSwaps = [];
        for(let key in swaps) {
            const swap = swaps[key];
            const expiryTime = swap.expiry;
            const currentTime = new bigDecimal(Math.floor(Date.now()/1000)-MAX_SOL_SKEW);

            if(expiryTime.compareTo(currentTime)<0) {
                cancelInvoices.push(swap.paymentHash);

                try {
                    const account = await program.account.escrowState.fetch(getEscrowStateKey(Buffer.from(swap.paymentHash, "hex")));
                    if(account!=null) {
                        if(
                            account.offerer.equals(_signer.publicKey) &&
                            new bigDecimal(account.expiry.toString(10)).compareTo(swap.expiry)===0 &&
                            new bigDecimal(account.initializerAmount.toString(10)).compareTo(swap.amount)===0 &&
                            account.mint.equals(swap.token)
                        ) {
                            refundSwaps.push(swap);
                        }
                    }
                } catch (e) {
                    console.error(e);
                }
            }
        }

        for(let refundSwap of refundSwaps) {

            let result = await program.methods
                .offererRefund()
                .accounts({
                    offerer: _signer.publicKey,
                    initializer: refundSwap.intermediary,
                    userData: userVaultKey,
                    escrowState: getEscrowStateKey(Buffer.from(refundSwap.paymentHash, "hex"))
                })
                .signers([_signer])
                .transaction();

            const signature = await _client.sendAndConfirm(result, [_signer]);

            console.log("[BTCLN->SOL: SOL.offerer_refund] Transaction confirmed! Signature: ", signature);
        }

        for(let paymentHash of cancelInvoices) {
            //Refund
            try {
                await lncli.cancelHodlInvoice({
                    lnd,
                    id: paymentHash
                });
                console.log("[BTCLN->SOL: SOL.Refunded] Invoice cancelled, because was timed out, id: ", paymentHash);
            } catch (e) {
                console.error("[BTCLN->SOL: SOL.Refunded] Cannot cancel hodl invoice id: ", paymentHash);
            }

            await removeSwapData(paymentHash);
        }
    }

    await execute();

    setInterval(execute, REFUND_CHECK_INTERVAL);

}

async function setupBTCLNtoSOL() {

    //Schedule a process to automatically claim outdated swaps and catch possible missed settlements
    await setupBTCLNtoSOLRefunder();

    //Run expressjs server listening for requests to generate invoices using provided payment hash, create hodl invoice
    const app = express();

    app.use(cors());
    app.use(express.json());

    app.post('/getInvoiceStatus', async function (req, res) {
        if (
            req.body == null ||

            req.body.paymentHash == null ||
            typeof(req.body.paymentHash) !== "string" ||
            req.body.paymentHash.length !== 64
        ) {
            res.status(400).json({
                msg: "Invalid request body (paymentHash)"
            });
            return;
        }

        const invoice = await lncli.getInvoice({
            id: req.body.paymentHash,
            lnd
        });

        try {
            if(!web3.PublicKey.isOnCurve(invoice.description)) {
                res.status(200).json({
                    code: 10001,
                    msg: "Invoice expired/canceled"
                });
                return;
            }
        } catch (e) {
            res.status(200).json({
                code: 10001,
                msg: "Invoice expired/canceled"
            });
            return;
        }

        if (!invoice.is_held) {
            if (invoice.is_canceled) {
                res.status(200).json({
                    code: 10001,
                    msg: "Invoice expired/canceled"
                });
            } else if (invoice.is_confirmed) {
                res.status(200).json({
                    code: 10002,
                    msg: "Invoice already paid"
                });
            } else {
                res.status(200).json({
                    code: 10003,
                    msg: "Invoice yet unpaid"
                });
            }
        }

        res.status(200).json({
            code: 10000,
            msg: "Success"
        });

    });

    app.post('/getInvoicePaymentAuth', async function (req, res) {
        if(
            req.body==null ||

            req.body.paymentHash==null ||
            typeof(req.body.paymentHash)!=="string" ||
            req.body.paymentHash.length!==64
        ) {
            res.status(400).json({
                msg: "Invalid request body (paymentHash)"
            });
            return;
        }

        const invoice = await lncli.getInvoice({
            id: req.body.paymentHash,
            lnd
        }).catch(e => console.error(e));

        if(invoice==null) {
            res.status(200).json({
                code: 10001,
                msg: "Invoice expired/canceled"
            });
            return;
        }

        try {
            if(!web3.PublicKey.isOnCurve(invoice.description)) {
                res.status(200).json({
                    code: 10001,
                    msg: "Invoice expired/canceled"
                });
                return;
            }
        } catch (e) {
            res.status(200).json({
                code: 10001,
                msg: "Invoice expired/canceled"
            });
            return;
        }

        if(!invoice.is_held) {
            if(invoice.is_canceled) {
                res.status(200).json({
                    code: 10001,
                    msg: "Invoice expired/canceled"
                });
            } else if(invoice.is_confirmed) {
                res.status(200).json({
                    code: 10002,
                    msg: "Invoice already paid"
                });
            } else {
                res.status(200).json({
                    code: 10003,
                    msg: "Invoice yet unpaid"
                });
            }
            return;
        }

        if(swaps[req.body.paymentHash]==null) {
            console.log("[BTCLN->SOL: LN.Held] held ln invoice: ", invoice);

            const tokenAccount = await program.account.userAccount.fetch(userVaultKey);
            const balance = new bigDecimal(tokenAccount.amount.toString(10));

            const invoiceAmount = new bigDecimal(invoice.received);

            const fee = BASE_FEE.add(invoiceAmount.multiply(FEE)).floor();

            const receivedAmount = invoiceAmount.subtract(fee);

            if(balance.compareTo(receivedAmount)<0) {
                await lncli.cancelHodlInvoice({
                    id: invoice.id,
                    lnd
                });
                console.error("[BTCLN->SOL: LN.Held] ERROR Not enough balance on SOL to honor the request");
                res.status(200).json({
                    code: 20001,
                    msg: "Not enough liquidity"
                });
                return;
            }

            let timeout = null;
            invoice.payments.forEach((curr) => {
                if(timeout==null || timeout>curr.timeout) timeout = curr.timeout;
            });
            const {current_block_height} = await lncli.getHeight({lnd});

            const blockDelta = new bigDecimal(timeout-current_block_height);

            console.log("[BTCLN->SOL: SOL.offerer_payReq] block delta: ", blockDelta.getValue());

            const expiryTimeout = blockDelta.multiply(BITCOIN_BLOCKTIME.divide(SAFETY_FACTOR, 0)).subtract(GRACE_PERIOD);

            console.log("[BTCLN->SOL: SOL.offerer_payReq] expiry timeout: ", expiryTimeout.getValue());

            if(expiryTimeout.compareTo(new bigDecimal(0))<0) {
                await lncli.cancelHodlInvoice({
                    id: invoice.id,
                    lnd
                });
                console.error("[BTCLN->SOL: SOL.offerer_payReq] Expire time is lower than 0");
                res.status(200).json({
                    code: 20002,
                    msg: "Not enough time to reliably process the swap"
                });
                return;
            }

            const payInvoiceObject = {
                intermediary: new web3.PublicKey(invoice.description),
                token: WBTC_ADDRESS,
                amount: receivedAmount,
                paymentHash: req.body.paymentHash,
                expiry: new bigDecimal(Date.now()/1000).add(expiryTimeout).floor(),
                committed: false
            };

            await saveSwapData(payInvoiceObject);
        }

        if(swaps[req.body.paymentHash].committed) {
            res.status(200).json({
                code: 10004,
                msg: "Invoice already committed"
            });
            return;
        }

        const payInvoiceObject = swaps[req.body.paymentHash];

        const authPrefix = "initialize";
        const authTimeout = Math.floor(Date.now()/1000)+AUTHORIZATION_TIMEOUT;
        const useNonce = getNonce()+1;

        const messageBuffers = [
            null,
            Buffer.alloc(8),
            null,
            null,
            Buffer.alloc(8),
            Buffer.alloc(8),
            null,
            Buffer.alloc(1),
            Buffer.alloc(2),
            Buffer.alloc(8)
        ];

        messageBuffers[0] = Buffer.from(authPrefix, "ascii");
        messageBuffers[1].writeBigUInt64LE(BigInt(useNonce));
        messageBuffers[2] = payInvoiceObject.token.toBuffer();
        messageBuffers[3] = payInvoiceObject.intermediary.toBuffer();
        messageBuffers[4].writeBigUInt64LE(BigInt(payInvoiceObject.amount.getValue()));
        messageBuffers[5].writeBigUInt64LE(BigInt(payInvoiceObject.expiry.getValue()));
        messageBuffers[6] = Buffer.from(payInvoiceObject.paymentHash, "hex");
        messageBuffers[7].writeUint8(0);
        messageBuffers[8].writeUint16LE(0);
        messageBuffers[9].writeBigUInt64LE(BigInt(authTimeout));

        const messageBuffer = Buffer.concat(messageBuffers);
        const signature = nacl.sign.detached(messageBuffer, _signer.secretKey);

        const sendObj = {...payInvoiceObject};
        sendObj.intermediary = payInvoiceObject.intermediary.toBase58();
        sendObj.token = payInvoiceObject.token.toBase58();
        sendObj.expiry = payInvoiceObject.expiry.getValue();
        sendObj.amount = payInvoiceObject.amount.getValue();

        res.status(200).json({
            code: 10000,
            msg: "Success",
            data: {
                address,
                data: sendObj,
                nonce: useNonce,
                prefix: authPrefix,
                timeout: authTimeout.toString(),
                signature: Buffer.from(signature).toString("hex")
            }
        });

    });

    app.post('/createInvoice', async function (req, res) {
        if(
            req.body==null ||
            req.body.address==null ||
            typeof(req.body.address)!=="string"
        ) {
            res.status(400).json({
                msg: "Invalid request body (address)"
            });
            return;
        }

        try {
            if(!web3.PublicKey.isOnCurve(req.body.address)) {
                res.status(400).json({
                    msg: "Invalid request body (address)"
                });
                return;
            }
        } catch (e) {
            res.status(400).json({
                msg: "Invalid request body (address)"
            });
            return;
        }

        if(
            req.body.paymentHash==null ||
            typeof(req.body.paymentHash)!=="string" ||
            req.body.paymentHash.length!==64 ||
            !HEX_REGEX.test(req.body.paymentHash)
        ) {
            res.status(400).json({
                msg: "Invalid request body (paymentHash)"
            });
            return;
        }

        if(
            req.body.amount==null ||
            typeof(req.body.amount)!=="string"
        ) {
            res.status(400).json({
                msg: "Invalid request body (amount)"
            });
            return;
        }

        let amountBD;
        try {
            amountBD = new bigDecimal(req.body.amount);
        } catch (e) {
            res.status(400).json({
                msg: "Invalid request body (amount)"
            });
            return;
        }

        if(amountBD.compareTo(MIN_AMOUNT_BTCLNtoSOL)<0) {
            res.status(400).json({
                msg: "Amount too low"
            });
            return;
        }

        if(amountBD.compareTo(MAX_AMOUNT_BTCLNtoSOL)>0) {
            res.status(400).json({
                msg: "Amount too high"
            });
            return;
        }

        const tokenAccount = await program.account.userAccount.fetch(userVaultKey);
        const balance = new bigDecimal(tokenAccount.amount.toString(10));

        if(amountBD.compareTo(balance)>0) {
            res.status(400).json({
                msg: "Not enough liquidity"
            });
            return;
        }

        if(
            req.body.expiry==null ||
            typeof(req.body.expiry)!=="number" ||
            isNaN(req.body.expiry) ||
            req.body.expiry<=0
        ) {
            res.status(400).json({
                msg: "Invalid request body (expiry)"
            });
            return;
        }

        //Add address to the invoice description
        const hodlInvoiceObj = {
            lnd,
            description: req.body.address,
            cltv_delta: MIN_LNRECEIVE_CTLV.getValue(),
            expires_at: new Date(Date.now()+(req.body.expiry*1000)).toISOString(),
            id: req.body.paymentHash,
            tokens: amountBD.getValue()
        };

        console.log("[BTCLN->SOL: LN.Create] creating hodl invoice: ", hodlInvoiceObj);

        const hodlInvoice = await lncli.createHodlInvoice(hodlInvoiceObj);

        console.log("[BTCLN->SOL: LN.Create] hodl invoice created: ", hodlInvoice);

        const swapFee = BASE_FEE.add(amountBD.multiply(FEE)).floor();

        res.status(200).json({
            msg: "Success",
            data: {
                pr: hodlInvoice.request,
                swapFee: swapFee.getValue()
            }
        });

    });

    app.listen(4000);

    console.log("[BTCLN->SOL: Webserver] running on port 4000");

}

async function processLogBTCLNtoSOL({events, instructions}) {

    const refundLogMap = {};

    for(let event of events) {
        if(event.name==="RefundEvent") {
            const hashBuffer = Buffer.from(event.data.hash);
            const key = getEscrowStateKey(hashBuffer);
            refundLogMap[key.toBase58()] = hashBuffer.toString("hex");
        }
    }

    for(let ix of instructions) {
        if(ix==null) continue;

        if (
            ix.name === "offererInitialize" &&
            ix.accounts.offerer.equals(_signer.publicKey)
        ) {
            //Increment nonce
            const paymentHash = Buffer.from(ix.data.hash).toString("hex");
            const savedSwap = swaps[paymentHash];

            if(savedSwap!=null) {
                savedSwap.committed = true;
            }

            //let _saveNonce = false;
            const usedNonce = ix.data.nonce.toNumber();
            if(usedNonce>getNonce()) {
                await saveNonce(usedNonce);
            }

            if(savedSwap!=null) {
                await saveSwapData(savedSwap);
            }

            // if(_saveNonce && nonce===usedNonce) {
            //     await saveNonce(nonce);
            // }
        }

        if(
            (ix.name==="claimerClaim" || ix.name==="claimerClaimPayOut") &&
            ix.accounts.offerer.equals(_signer.publicKey)
        ) {

            //Claim
            //This is the important part, we need to catch the claim TX, else we may lose money
            const secret = Buffer.from(ix.data.secret);
            const paymentHash = crypto.createHash("sha256").update(secret).digest();

            const secretHex = secret.toString("hex");
            const paymentHashHex = paymentHash.toString("hex");

            const savedSwap = swaps[paymentHashHex];

            if(savedSwap==null) {
                continue;
            }

            try {
                await lncli.settleHodlInvoice({
                    lnd,
                    secret: secretHex
                });
                console.log("[BTCLN->SOL: SOL.Claimed] Invoice settled, id: ", paymentHashHex);
            } catch (e) {
                console.error("[BTCLN->SOL: SOL.Claimed] FATAL Cannot settle hodl invoice id: "+paymentHashHex+" secret: ", secretHex);
            }

            await removeSwapData(paymentHashHex);

        }

        if(
            (ix.name==="offererRefund" || ix.name==="offererRefundWithSignature" || ix.name==="offererRefundPayOut" || ix.name==="offererRefundWithSignaturePayOut")
            && ix.accounts.offerer.equals(_signer.publicKey)) {

            //Refund
            //Try to get the hash from the refundMap
            const paymentHash = refundLogMap[ix.accounts.escrowState.toBase58()];

            if(paymentHash==null) {
                continue;
            }

            try {
                //TODO: If this fails we may need to refund
                await lncli.cancelHodlInvoice({
                    lnd,
                    id: paymentHash
                });
                console.log("[BTCLN->SOL: SOL.Refunded] Invoice cancelled, because was refunded, id: ", paymentHash);
            } catch (e) {
                console.error("[BTCLN->SOL: SOL.Refunded] Cannot cancel hodl invoice id: ", paymentHash);
            }

            await removeSwapData(paymentHash);

        }
    }
}

module.exports = {
    setupBTCLNtoSOL,
    processLogBTCLNtoSOL,
    loadBTCLNtoSOL
};