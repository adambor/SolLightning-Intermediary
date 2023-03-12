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
const bitcoin = require("bitcoinjs-lib");
const relayUtils = require("./relayUtils");

const {_client, NETWORK, _signer, address, lnd, btcRpc, GRACE_PERIOD, SAFETY_FACTOR, CHAIN_SEND_SAFETY_FACTOR, CHAIN_BASE_FEE, CHAIN_FEE, NETWORK_FEE_MULTIPLIER, AUTHORIZATION_TIMEOUT, BITCOIN_BLOCKTIME, BASE_FEE, FEE, WBTC_ADDRESS, CHAIN_ID, AUTHORITY_SEED, USER_VAULT_SEED, VAULT_SEED, STATE_SEED} = require("./constants");

const TX_CHECK_INTERVAL = 10*1000;

const OFFER_EXPIRY = 60*10;

const MIN_ONCHAIN_END_CTLV = new bigDecimal(10);
//const MIN_ONCHAIN_TS_DELTA = GRACE_PERIOD.add(BITCOIN_BLOCKTIME.multiply(MIN_ONCHAIN_END_CTLV).multiply(SAFETY_FACTOR));

const MAX_CONFIRMATIONS = 12;
const MIN_CONFIRMATIONS = 2;

const MAX_CONFIRMATION_TARGET = 6;
const MIN_CONFIRMATION_TARGET = 1;

function getExpiryFromCLTV(confirmationTarget, confirmations) {
    const cltv = MIN_ONCHAIN_END_CTLV.add(
        new bigDecimal(confirmations).add(new bigDecimal(confirmationTarget)).multiply(CHAIN_SEND_SAFETY_FACTOR)
    );

    return GRACE_PERIOD.add(BITCOIN_BLOCKTIME.multiply(cltv).multiply(SAFETY_FACTOR));

}

const MIN_AMOUNT = new bigDecimal(5000);
const MAX_AMOUNT = new bigDecimal(1000000);

const OUTPUT_SCRIPT_MAX_LENGTH = 200;

const program = new anchor.Program(programIdl, programIdl.metadata.address, _client);

const userVaultKey = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(USER_VAULT_SEED), _signer.publicKey.toBuffer(), WBTC_ADDRESS.toBuffer()],
    program.programId
)[0];

function getTxDataKey(reversedTxId) {
    return anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from(anchor.utils.bytes.utf8.encode("data")), reversedTxId, _signer.publicKey.toBuffer()],
        program.programId
    )[0];
}

//Param: hash - Buffer
function getEscrowStateKey(hash) {
    return web3.PublicKey.findProgramAddressSync(
        [Buffer.from(STATE_SEED), hash],
        program.programId
    )[0];
}

const dirName = "soltobtc";

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

    if(cpy.amount!=null) {
        cpy.amount = obj.amount.getValue();
    }
    if(cpy.total!=null) {
        cpy.total = obj.total.getValue();
    }
    if(cpy.networkFee!=null) {
        cpy.networkFee = obj.networkFee.getValue();
    }
    if(cpy.satsPervByte!=null) {
        cpy.satsPervByte = obj.satsPervByte.getValue();
    }
    if(cpy.swapFee!=null) {
        cpy.swapFee = obj.swapFee.getValue();
    }
    if(cpy.requiredExpiryTs!=null) {
        cpy.requiredExpiryTs = obj.requiredExpiryTs.getValue();
    }
    if(cpy.offerer!=null) {
        cpy.offerer = obj.offerer.toBase58();
    }
    if(cpy.data!=null) {
        cpy.data = {
            initializer: obj.data.initializer.toBase58(),
            intermediary: obj.data.intermediary.toBase58(),
            token: obj.data.token.toBase58(),
            amount: obj.data.amount.getValue(),
            paymentHash: obj.data.paymentHash,
            expiry: obj.data.expiry.getValue(),
            nonce: obj.data.nonce.getValue()
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
        if(obj.amount!=null) {
            obj.amount = new bigDecimal(obj.amount);
        }
        if(obj.total!=null) {
            obj.total = new bigDecimal(obj.total);
        }
        if(obj.networkFee!=null) {
            obj.networkFee = new bigDecimal(obj.networkFee);
        }
        if(obj.satsPervByte!=null) {
            obj.satsPervByte = new bigDecimal(obj.satsPervByte);
        }
        if(obj.swapFee!=null) {
            obj.swapFee = new bigDecimal(obj.swapFee);
        }
        if(obj.requiredExpiryTs!=null) {
            obj.requiredExpiryTs = new bigDecimal(obj.requiredExpiryTs);
        }
        if(obj.offerer!=null) {
            obj.offerer = new web3.PublicKey(obj.offerer);
        }
        if(obj.data!=null) {
            obj.data.initializer = new web3.PublicKey(obj.data.initializer);
            obj.data.intermediary = new web3.PublicKey(obj.data.intermediary);
            obj.data.token = new web3.PublicKey(obj.data.token);
            obj.data.expiry = new bigDecimal(obj.data.expiry);
            obj.data.amount = new bigDecimal(obj.data.amount);
            obj.data.nonce = new bigDecimal(obj.data.nonce);
        }
        arr.push(obj);
    }

    return arr;
}

async function processPaymentResult(tx, payment, vout) {
    let blockheader;
    try {
        blockheader = await new Promise((resolve, reject) => {
            btcRpc.getBlockHeader(tx.blockhash, true, (err, info) => {
                if(err) {
                    reject(err);
                    return;
                }
                resolve(info.result);
            });
        });
    } catch (e) {
        console.error(e);
    }

    console.log("[SOL->BTC: SOL.claimer_claim] Blockheader fetched: ", blockheader);

    if(blockheader==null) return;

    let commitedHeader;
    try {
        commitedHeader = await relayUtils.retrieveBlockLog(blockheader.hash);
    } catch (e) {
        console.error(e);
    }

    console.log("[SOL->BTC: SOL.claimer_claim] Commited header retrieved: ", commitedHeader);

    if(commitedHeader==null) return;

    //Now we only need to obtain merkle proof
    const merkleProof = await relayUtils.getTransactionMerkle(btcRpc, tx.txid, tx.blockhash);

    console.log("[SOL->BTC: SOL.claimer_claim] Merkle proof computed: ", merkleProof);

    const rawTxBuffer = Buffer.from(tx.hex, "hex");
    const writeData = Buffer.concat([
        Buffer.from(new anchor.BN(vout.n).toArray("le", 4)),
        rawTxBuffer
    ]);

    console.log("[SOL->BTC: SOL.claimer_claim] Writing transaction data: ", writeData.toString("hex"));

    const txDataKey = getTxDataKey(merkleProof.reversedTxId);

    try {
        const fetchedDataAccount = await program.account.data.fetch(txDataKey);
        console.log("[SOL->BTC: SOL.claimer_claim] Will erase previous data account");
        const eraseTx = await program.methods
            .closeData(merkleProof.reversedTxId)
            .accounts({
                signer: _signer.publicKey,
                data: txDataKey
            })
            .signers([_signer])
            .transaction();

        const signature = await _client.sendAndConfirm(eraseTx, [_signer]);
        console.log("[SOL->BTC: SOL.claimer_claim] Previous data account erased: ", signature);
    } catch (e) {}

    let pointer = 0;
    while(pointer<writeData.length) {
        const writeLen = Math.min(writeData.length-pointer, 1000);

        const writeTx = await program.methods
            .writeData(merkleProof.reversedTxId, writeData.length, writeData.slice(pointer, writeLen))
            .accounts({
                signer: _signer.publicKey,
                data: txDataKey,
                systemProgram: web3.SystemProgram.programId
            })
            .signers([_signer])
            .transaction();

        const signature = await _client.sendAndConfirm(writeTx, [_signer]);

        console.log("[SOL->BTC: SOL.claimer_claim] Write partial tx data ("+pointer+" .. "+(pointer+writeLen)+")/"+writeData.length+": ", signature);

        pointer += writeLen;
    }

    console.log("[SOL->BTC: SOL.claimer_claim] Tx data written");

    const verifyIx = await relayUtils.createVerifyIx(_signer, merkleProof.reversedTxId, payment.confirmations, merkleProof.pos, merkleProof.merkle, commitedHeader);
    const claimIx = await program.methods
        .claimerClaimWithExtData(merkleProof.reversedTxId)
        .accounts({
            claimer: _signer.publicKey,
            offerer: payment.offerer,
            initializer: payment.data.initializer,
            data: txDataKey,
            userData: userVaultKey,
            escrowState: getEscrowStateKey(Buffer.from(payment.hash, "hex")),
            systemProgram: web3.SystemProgram.programId,
            ixSysvar: web3.SYSVAR_INSTRUCTIONS_PUBKEY
        })
        .signers([_signer])
        .instruction();

    const solanaTx = new anchor.web3.Transaction();
    solanaTx.add(verifyIx);
    solanaTx.add(claimIx);
    solanaTx.feePayer = _signer.publicKey;
    solanaTx.recentBlockhash = (await _client.connection.getRecentBlockhash()).blockhash;

    console.log("[SOL->BTC: SOL.claimer_claim] Solana claim transaction created: ", solanaTx);

    const signature = await _client.sendAndConfirm(solanaTx, [_signer]);
    console.log("[SOL->BTC: SOL.claimer_claim] Transaction sent: ", signature);

    return true;

}

async function loadSOLtoBTC() {

    const loadedInvoices = await loadInvoiceData();

    for(let payment of loadedInvoices) {
        invoices[payment.hash] = payment;
    }

    let processFunc;
    processFunc = async () => {
        try {
            await checkPayments();
        } catch (e) {
            console.error(e);
        }
        setTimeout(processFunc, TX_CHECK_INTERVAL);
    };

    setTimeout(processFunc, TX_CHECK_INTERVAL);

}

async function checkPastInvoices() {

    for(let key in invoices) {
        const payment = invoices[key];

        if(payment.state===0) {
            //Yet unpaid
            if(payment.offerExpiry<Date.now()/1000) {
                //Expired
                await removeInvoiceData(key);
                continue;
            }
        }

        if(payment.state===-1) {
            if(payment.requiredExpiryTs.compareTo(new bigDecimal(Date.now()/1000))<0) {
                //Expired
                await removeInvoiceData(key);
                continue;
            }
        }

        if(payment.state===2 || payment.state===1 || payment.state===0.5) {
            await processSOLtoBTC(payment, payment.offerer, payment.data);
            continue;
        }

    }

}

const activeSubscriptions = {};

async function checkPayments() {

    for(let txId in activeSubscriptions) {
        const payment = activeSubscriptions[txId];
        let tx;
        try {
            tx = await new Promise((resolve, reject) => {
                btcRpc.getRawTransaction(txId, 1, (err, info) => {
                    if(err) {
                        reject(err);
                        return;
                    }
                    resolve(info.result);
                });
            });
        } catch (e) {
            console.error(e);
        }

        if(tx==null) {
            continue;
        }

        if(tx.confirmations==null) tx.confirmations = 0;

        if(tx.confirmations<payment.confirmations) {
            //not enough confirmations
            continue;
        }

        const outputScript = bitcoin.address.toOutputScript(payment.address, NETWORK);

        console.log("TX vouts: ", tx.vout);

        console.log("Output script: ", outputScript.toString("hex"));
        console.log("Amount: ", payment.amount.getValue());

        const vout = tx.vout.find(e => new bigDecimal(e.value).multiply(new bigDecimal(100000000)).compareTo(payment.amount)===0 && Buffer.from(e.scriptPubKey.hex, "hex").equals(outputScript));

        if(vout==null) {
            console.error("Cannot find vout!!");
            continue;
        }

        const success = await processPaymentResult(tx, payment, vout);

        if(success) delete activeSubscriptions[txId];
    }

}

function subscribeToPayment(payment, offerer, data) {

    activeSubscriptions[payment.txId] = payment;

}

async function processSOLtoBTC(payment, offerer, data) {
    if(payment.state===1) {
        //Payment was signed (maybe also sent)
        let tx;
        try {
            tx = await new Promise((resolve, reject) => {
                btcRpc.getRawTransaction(payment.txId, 1, (err, info) => {
                    if(err) {
                        reject(err);
                        return;
                    }
                    resolve(info.result);
                });
            });
        } catch (e) {
            console.error(e);
        }

        if(tx==null) {
            payment.state = 0;
        }
    }

    if(payment.state===0) {
        if(payment.offerExpiry<(Date.now()/1000)) {
            console.error("[SOL->BTC: SOL.PaymentRequest] Transaction submitted too late");
            payment.state = -1;
            payment.offerer = offerer;
            payment.data = data;
            await saveInvoiceData(data.paymentHash, payment);
            return;
        }

        if(data.expiry.compareTo(payment.requiredExpiryTs)<0) {
            console.error("[SOL->BTC: SOL.PaymentRequest] requiredExpiryTs condition not met");
            payment.state = -1;
            payment.offerer = offerer;
            payment.data = data;
            await saveInvoiceData(data.paymentHash, payment);
            return;
        }

        if(data.confirmations > payment.confirmations) {
            console.error("[SOL->BTC: SOL.PaymentRequest] confirmations condition not met");
            payment.state = -1;
            payment.offerer = offerer;
            payment.data = data;
            await saveInvoiceData(data.paymentHash, payment);
            return;
        }

        const tokenAddress = data.token;

        if(!tokenAddress.equals(WBTC_ADDRESS)) {
            console.error("[SOL->BTC: SOL.PaymentRequest] Invalid token used");
            payment.state = -1;
            payment.offerer = offerer;
            payment.data = data;
            await saveInvoiceData(data.paymentHash, payment);
            return;
        }

        console.log("[SOL->BTC: SOL.PaymentRequest] Struct: ", data);

        if(data.amount.compareTo(payment.total)<0) {
            console.error("[SOL->BTC: SOL.PaymentRequest] Low payment amount: " + data.amount.getValue() + " minimum: " + payment.total.getValue());
            payment.state = -1;
            payment.offerer = offerer;
            payment.data = data;
            await saveInvoiceData(data.paymentHash, payment);
            return;
        }

        let fundPsbtResponse;
        try {
            fundPsbtResponse = await lncli.fundPsbt({
                lnd,
                outputs: [
                    {
                        address: payment.address,
                        tokens: parseInt(payment.amount.getValue())
                    }
                ],
                target_confirmations: payment.confirmationTarget,
                min_confirmations: 0 //TODO: This might not be the best idea
            });
        } catch (e) {
            console.error(e);
        }

        if(fundPsbtResponse==null) {
            //Here we can retry till offerExpiry, then we set state to -1
            payment.state = 0.5;
            payment.offerer = offerer;
            payment.data = data;
            await saveInvoiceData(data.paymentHash, payment);
            return;
        }

        let psbt = bitcoin.Psbt.fromHex(fundPsbtResponse.psbt);

        const nonceBN = new anchor.BN(data.nonce.getValue());
        const nonceBuffer = Buffer.from(nonceBN.toArray("be", 8));

        const locktimeBN = new anchor.BN(nonceBuffer.slice(0, 5), "be");
        const sequenceBN = new anchor.BN(nonceBuffer.slice(5, 8), "be");

        //Apply nonce
        let locktime = locktimeBN.toNumber();
        console.log("locktime: ", locktime);

        locktime += 500000000;
        psbt.setLocktime(locktime);

        console.log("Sequence base: ", sequenceBN.toNumber());
        const sequence = 0xFE000000 + sequenceBN.toNumber();
        console.log("sequence: ", sequence);

        for(let txIn of psbt.__CACHE.__TX.ins) {
            txIn.sequence = sequence;
        }

        const psbtHex = psbt.toHex();

        let signedPsbt;
        try {
            signedPsbt = await lncli.signPsbt({
                lnd,
                psbt: psbtHex
            });
        } catch (e) {
            console.error(e);
        }

        if(signedPsbt==null) {
            console.error("[SOL->BTC: SOL.PaymentRequest] Failed to sign psbt!");
            for(let input of fundPsbtResponse.inputs) {
                await lncli.unlockUtxo({
                    lnd,
                    id: input.lock_id,
                    transaction_id: input.transaction_id,
                    transaction_vout: input.transaction_vout
                });
            }
            payment.state = 0.5;
            payment.offerer = offerer;
            payment.data = data;
            await saveInvoiceData(data.paymentHash, payment);
            return;
        }

        psbt = bitcoin.Psbt.fromHex(signedPsbt.psbt);

        if(payment.networkFee.compareTo(new bigDecimal(psbt.getFee()))<0) {
            console.error("[SOL->BTC: SOL.PaymentRequest] Fee changed too much!");
            for(let input of fundPsbtResponse.inputs) {
                await lncli.unlockUtxo({
                    lnd,
                    id: input.lock_id,
                    transaction_id: input.transaction_id,
                    transaction_vout: input.transaction_vout
                });
            }
            payment.state = -1;
            payment.offerer = offerer;
            payment.data = data;
            await saveInvoiceData(data.paymentHash, payment);
            return;
        }

        console.log("Generated raw transaction: ", signedPsbt.transaction);

        const tx = bitcoin.Transaction.fromHex(signedPsbt.transaction);
        const txId = tx.getId();

        payment.state = 1;
        payment.offerer = offerer;
        payment.data = data;
        payment.txId = txId;
        await saveInvoiceData(data.paymentHash, payment);

        let txSendResult;
        try {
            txSendResult = await lncli.broadcastChainTransaction({
                lnd,
                transaction: signedPsbt.transaction
            });
        } catch (e) {
            console.error(e);
        }

        if(txSendResult==null) {
            console.error("[SOL->BTC: SOL.PaymentRequest] Failed to broadcast transaction!");
            for(let input of fundPsbtResponse.inputs) {
                await lncli.unlockUtxo({
                    lnd,
                    id: input.lock_id,
                    transaction_id: input.transaction_id,
                    transaction_vout: input.transaction_vout
                });
            }
            payment.state = 0.5;
            payment.offerer = offerer;
            payment.data = data;
            await saveInvoiceData(data.paymentHash, payment);
            return;
        }

        payment.state = 2;
        payment.offerer = offerer;
        payment.data = data;
        await saveInvoiceData(data.paymentHash, payment);
    }

    if(payment.state===-1) {
        //Payment was declined
        return;
    }

    subscribeToPayment(payment, offerer, data);

}

async function setupSOLtoBTC() {

    await checkPastInvoices();

    const app = express();

    app.use(cors());
    app.use(express.json());

    app.post('/payInvoice', async function (req, res) {
        if (
            req.body == null ||

            req.body.address == null ||
            typeof(req.body.address) !== "string" ||

            req.body.amount == null ||
            typeof(req.body.amount) !== "string" ||

            req.body.confirmationTarget == null ||
            typeof(req.body.confirmationTarget) !== "number" ||

            req.body.confirmations == null ||
            typeof(req.body.confirmations) !== "number" ||

            req.body.nonce == null ||
            typeof(req.body.nonce) !== "string"
        ) {
            res.status(400).json({
                msg: "Invalid request body (address/amount/confirmationTarget/confirmations)"
            });
            return;
        }

        let amountBD;

        try {
            amountBD = new bigDecimal(req.body.amount);
        } catch (e) {
            res.status(400).json({
                msg: "Invalid request body (amount - cannot be parsed)"
            });
            return;
        }

        let nonce;

        try {
            nonce = new anchor.BN(req.body.nonce);
        } catch (e) {
            res.status(400).json({
                msg: "Invalid request body (nonce - cannot be parsed)"
            });
            return;
        }

        const nonceBuffer = Buffer.from(nonce.toArray("be", 8));
        const firstPart = new anchor.BN(nonceBuffer.slice(0, 5), "be");

        const maxAllowedValue = new anchor.BN(Math.floor(Date.now()/1000)-600000000);
        if(firstPart.gt(maxAllowedValue)) {
            res.status(400).json({
                msg: "Invalid request body (nonce - too high)"
            });
            return;
        }

        const currentTimestamp = new bigDecimal(Date.now()/1000);

        if(req.body.confirmationTarget>MAX_CONFIRMATION_TARGET) {
            res.status(400).json({
                msg: "Invalid request body (confirmationTarget - too high)"
            });
            return;
        }
        if(req.body.confirmationTarget<MIN_CONFIRMATION_TARGET) {
            res.status(400).json({
                msg: "Invalid request body (confirmationTarget - too low)"
            });
            return;
        }

        if(req.body.confirmations>MAX_CONFIRMATIONS) {
            res.status(400).json({
                msg: "Invalid request body (confirmations - too high)"
            });
            return;
        }
        if(req.body.confirmations<MIN_CONFIRMATIONS) {
            res.status(400).json({
                msg: "Invalid request body (confirmations - too low)"
            });
            return;
        }

        let parsedOutputScript;

        try {
            parsedOutputScript = bitcoin.address.toOutputScript(req.body.address, NETWORK);
        } catch (e) {
            res.status(400).json({
                msg: "Invalid request body (address - cannot be parsed)"
            });
            return;
        }

        if(parsedOutputScript.length > OUTPUT_SCRIPT_MAX_LENGTH) {
            res.status(400).json({
                msg: "Invalid request body (address's output script - too long)"
            });
            return;
        }

        const expirySeconds = getExpiryFromCLTV(req.body.confirmationTarget, req.body.confirmations);

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

        let chainFeeResp;
        try {
            chainFeeResp = await lncli.getChainFeeEstimate({
                lnd,
                send_to: [
                    {
                        address: req.body.address,
                        tokens: parseInt(req.body.amount)
                    }
                ],
                target_confirmations: req.body.confirmationTarget,
                utxo_confirmations: 0
            });
        } catch (e) {
            console.error(e);
        }

        if(chainFeeResp==null) {
            res.status(400).json({
                code: 20002,
                msg: "Insufficient liquidity!"
            });
        }

        const networkFee = chainFeeResp.fee;
        const feeSatsPervByte = chainFeeResp.tokens_per_vbyte;

        console.log("Total network fee: ", networkFee);
        console.log("Network fee (sats/vB): ", feeSatsPervByte);

        const networkFeeAdjusted = new bigDecimal(networkFee).multiply(NETWORK_FEE_MULTIPLIER).ceil();
        const feeSatsPervByteAdjusted = new bigDecimal(feeSatsPervByte).multiply(NETWORK_FEE_MULTIPLIER).ceil();

        console.log("Total network fee: ", networkFeeAdjusted.getValue());
        console.log("Network fee (sats/vB): ", feeSatsPervByteAdjusted.getValue());

        const swapFee = CHAIN_BASE_FEE.add(amountBD.multiply(CHAIN_FEE)).ceil();

        const hash = crypto.createHash("sha256").update(Buffer.concat([
            Buffer.from(nonce.toArray("le", 8)),
            Buffer.from(new anchor.BN(amountBD.getValue()).toArray("le", 8)),
            parsedOutputScript
        ])).digest().toString("hex");

        const offerExpiry = Math.floor((Date.now()/1000)+OFFER_EXPIRY);

        const minRequiredExpiry = currentTimestamp.add(expirySeconds).ceil();

        const total = amountBD.add(networkFeeAdjusted).add(swapFee);

        await saveInvoiceData(hash, {
            state: 0,
            hash: hash,
            address: req.body.address,
            confirmations: req.body.confirmations,
            confirmationTarget: req.body.confirmationTarget,
            amount: amountBD,
            networkFee: networkFeeAdjusted,
            satsPervByte: feeSatsPervByteAdjusted,
            swapFee: swapFee,
            total,
            requiredExpiryTs: minRequiredExpiry,
            offerExpiry: offerExpiry
        });

        res.status(200).json({
            code: 20000,
            msg: "Success",
            data: {
                address,
                networkFee: networkFeeAdjusted.getValue(),
                satsPervByte: feeSatsPervByteAdjusted.getValue(),
                swapFee: swapFee.getValue(),
                totalFee: swapFee.add(networkFeeAdjusted).getValue(),
                total: total.getValue(),
                minRequiredExpiry: minRequiredExpiry.getValue(),
                offerExpiry
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

        const payment = invoices[req.body.paymentHash];

        if(payment==null || payment.state===0) {
            res.status(200).json({
                code: 20007,
                msg: "Payment not found"
            });
            return;
        }

        if(payment.state===0.5 || payment.state===1) {
            res.status(200).json({
                code: 20008,
                msg: "Payment processing"
            });
            return;
        }

        if(payment.state===2) {
            res.status(200).json({
                code: 20006,
                msg: "Already paid",
                data: {
                    txId: payment.txId
                }
            });
            return;
        }

        if(payment.state===-1) {
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

    app.listen(4003);

    console.log("[SOL->BTC: Webserver] running on port 4003");

}

//const requestFilter = contractSOLtoBTC.filters.PaymentRequest(null, address);
//const claimFilterSOLtoBTC = contractSOLtoBTC.filters.Claimed(null, address);

async function processLogSOLtoBTC({events, instructions}) {

    const initializeLogMap = {};

    for(let event of events) {
        if(event.name==="InitializeEvent") {
            const hashBuffer = Buffer.from(event.data.hash);
            console.log("InitializeEvent: ", hashBuffer.toString("hex"));
            initializeLogMap[hashBuffer.toString("hex")] = {
                nonce: event.data.nonce
            };
        }

        if(event.name==="ClaimEvent") {
            const paymentHash = Buffer.from(event.data.hash).toString("hex");

            const savedInvoice = invoices[paymentHash];

            if(savedInvoice==null) {
                console.error("[SOL->BTC: SOL.claimer_claim] No invoice submitted");
                continue;
            }

            console.log("[SOL->BTC: SOL.claimer_claim] Transaction confirmed! Event: ", event);

            await removeInvoiceData(paymentHash);
        }

        if(event.name==="RefundEvent") {
            const paymentHash = Buffer.from(event.data.hash).digest().toString("hex");

            const savedInvoice = invoices[paymentHash];

            if(savedInvoice==null) {
                console.error("[SOL->BTC: SOL.claimer_refund] No invoice submitted");
                continue;
            }

            console.log("[SOL->BTC: SOL.claimer_refund] Transaction refunded! Event: ", event);

            await removeInvoiceData(paymentHash);
        }
    }

    for(let ix of instructions) {
        if (ix == null) continue;

        if (
            (ix.name === "offererInitializePayIn" || ix.name === "offererInitialize") &&
            ix.accounts.claimer.equals(_signer.publicKey)
        ) {
            if(ix.data.kind!==2) {
                //Only process nonced on-chain requests
                continue;
            }

            const paymentHash = Buffer.from(ix.data.hash).toString("hex");

            console.log("[SOL->BTC: SOL.PaymentRequest] Payment hash: ", paymentHash);

            const savedInvoice = invoices[paymentHash];

            if(savedInvoice==null) {
                console.error("[SOL->BTC: SOL.PaymentRequest] No invoice submitted");
                continue;
            }

            console.error("[SOL->BTC: SOL.PaymentRequest] SOL request submitted");

            let offerer;
            if(ix.name === "offererInitializePayIn") {
                offerer = ix.accounts.initializer;
            } else {
                offerer = ix.accounts.offerer;
            }

            const log = initializeLogMap[paymentHash];

            if(log==null) {
                console.error("[SOL->BTC: SOL.PaymentRequest] Corresponding log not found");
                continue;
            }

            console.log("[SOL->BTC: SOL.PaymentRequest] Processing swap id: ", paymentHash);

            await processSOLtoBTC(savedInvoice, offerer, {
                initializer: ix.accounts.initializer,
                intermediary: ix.accounts.claimer,
                token: ix.accounts.mint,
                confirmations: ix.data.confirmations,
                amount: new bigDecimal(ix.data.initializerAmount.toString(10)),
                paymentHash: paymentHash,
                expiry: new bigDecimal(ix.data.expiry.toString(10)),
                nonce: new bigDecimal(log.nonce)
            });

        }
    }
}

module.exports = {
    setupSOLtoBTC,
    processLogSOLtoBTC,
    loadSOLtoBTC
}