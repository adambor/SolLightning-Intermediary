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
const bitcoin = require("bitcoinjs-lib");
const {loadNonce, saveNonce, getNonce} = require("./nonce");

const {MAX_SOL_SKEW, NETWORK, _client, _signer, address, lnd, btcRpc, BITCOIN_BLOCKTIME, NETWORK_FEE_MULTIPLIER, SAFETY_FACTOR, GRACE_PERIOD, AUTHORIZATION_TIMEOUT, WBTC_ADDRESS, FEE, BASE_FEE, STATE_SEED, AUTHORITY_SEED, USER_VAULT_SEED, VAULT_SEED} = require("./constants");

const HEX_REGEX = /[0-9a-fA-F]+/;

const CONFIRMATIONS = 3;
const SWAP_CSV_DELTA = 72; //Half a day
const HTLC_SWEEP_VBYTES = 140;

const MIN_AMOUNT_BTCtoSOL = new bigDecimal(10000);
const MAX_AMOUNT_BTCtoSOL = new bigDecimal(1000000);

const REFUND_CHECK_INTERVAL = 15*60*1000;

const program = new anchor.Program(programIdl, programIdl.metadata.address, _client);

const dirName = "btctosol";

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
    if(cpy.intermediary!=null) cpy.intermediary = obj.intermediary.toBase58();
    if(cpy.token!=null) cpy.token = obj.token.toBase58();
    if(cpy.amount!=null) cpy.amount = obj.amount.getValue();
    if(cpy.expectedNetworkFee!=null) cpy.expectedNetworkFee = obj.expectedNetworkFee.getValue()
    if(cpy.utxoAmount!=null) cpy.utxoAmount = obj.utxoAmount.getValue();
    if(cpy.expiry!=null) cpy.expiry = obj.expiry.getValue();

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
        if(obj.intermediary!=null) obj.intermediary = new web3.PublicKey(obj.intermediary);
        if(obj.token!=null) obj.token = new web3.PublicKey(obj.token);
        if(obj.expiry!=null) obj.expiry = new bigDecimal(obj.expiry);
        if(obj.amount!=null) obj.amount = new bigDecimal(obj.amount);
        if(obj.expectedNetworkFee!=null) obj.expectedNetworkFee = new bigDecimal(obj.expectedNetworkFee);
        if(obj.utxoAmount!=null) obj.utxoAmount = new bigDecimal(obj.utxoAmount);
        arr.push(obj);
    }

    return arr;
}

async function loadBTCtoSOL() {

    const arr = await loadSwapData();

    for(let obj of arr) {
        swaps[obj.paymentHash] = obj;
    }

    await loadNonce();
}

async function setupBTCtoSOLRefunder() {

    async function execute() {
        console.log("[BTC->SOL: SOL.CheckRefunds] Checking possible refunds...");

        //Check expiration on swaps
        const cancelInvoices = [];
        const refundSwaps = [];
        for(let key in swaps) {
            const swap = swaps[key];

            if(swap.state===0) continue;

            const expiryTime = swap.expiry;
            const currentTime = new bigDecimal(Math.floor(Date.now()/1000)-MAX_SOL_SKEW);

            if(expiryTime.compareTo(currentTime)<0) {
                cancelInvoices.push(swap.paymentHash.substring(2));

                if(swap.state===2) { //Committed
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

            console.log("[BTC->SOL: SOL.offerer_refund] Transaction confirmed! Signature: ", signature);
        }

        for(let paymentHash of cancelInvoices) {
            await removeSwapData(paymentHash);
        }
    }

    await execute();

    setInterval(execute, REFUND_CHECK_INTERVAL);

}

/**
 *
 * @param prev_txId                 Tx id of UTXO
 * @param prev_vout                 Vout of UTXO
 * @param key_index                 Node's key index
 * @param address                   Address of the HTLC
 * @param sweepAddress              Sweep to this address
 * @param witnessScriptBuffer       Witness locking script buffer
 * @param value                     Value of the utxo
 * @param fee                       Fee in sats
 * @returns {Promise<string>}
 */
async function getSignatureForSweepTx(prev_txId, prev_vout, key_index, address, sweepAddress, witnessScriptBuffer, value, fee) {

    let rawTx = "02000000"; //Version 2
    rawTx += "0001"; //Segwit flag
    rawTx += "01"; //Input count
    rawTx += Buffer.from(prev_txId, "hex").reverse().toString("hex"); //Input hash
    const voutBuffer = Buffer.alloc(4);
    voutBuffer.writeUint32LE(prev_vout);
    rawTx += voutBuffer.toString("hex"); //Input index
    rawTx += "00"; //Input script len
    rawTx += "ffffffff"; //Input nSequence

    rawTx += "01"; //Output count
    const amountBuffer = Buffer.alloc(8);
    amountBuffer.writeBigUint64LE(BigInt(value-fee));
    rawTx += amountBuffer.toString("hex"); //Output amount
    const outputScriptBuffer = bitcoin.address.toOutputScript(sweepAddress, NETWORK); //Output script
    rawTx += outputScriptBuffer.length.toString(16).padStart(2, "0"); //Output script len
    rawTx += outputScriptBuffer.toString("hex"); //Output script
    rawTx += "00"; //Witness pushes
    rawTx += "00000000"; //Locktime

    const resp = await lncli.signTransaction({
        lnd,
        inputs: [
            {
                key_family: 1,
                key_index: key_index,
                output_script: bitcoin.address.toOutputScript(address, NETWORK).toString("hex"),
                witness_script: witnessScriptBuffer.toString("hex"),
                output_tokens: value,
                sighash: 0x01, //SIGHASH_ALL
                vin: 0
            }
        ],
        transaction: rawTx
    });

    const signature = resp.signatures[0]+"01"; //Append 0x01 for SIGHASH_ALL

    return signature;

}

//TODO: Protect against possible dust outputs of sweep transaction
async function sweepHTLC(paymentHashBuffer, secretBuffer) {

    const swapData = swaps[paymentHashBuffer.toString("hex")];

    if(swapData==null) throw new Error("HTLC not found");

    if(swapData.txId==null || swapData.vout==null) throw new Error("Invalid state of the HTLC");

    const resp = await lncli.createChainAddress({
        lnd,
        format: "p2wpkh"
    });

    const {tokens_per_vbyte} = await lncli.getChainFeeRate({lnd, confirmation_target: 2});

    const lockingScript = generateLockingScript(swapData.csvDelta, paymentHashBuffer, swapData.publicKey, swapData.btcPublicKey);

    if(lockingScript.address!==swapData.htlcAddress) throw new Error("HTLC address mismatch");

    const fee = Math.ceil(tokens_per_vbyte*HTLC_SWEEP_VBYTES);

    const utxoAmount = parseInt(swapData.utxoAmount.getValue());

    console.log("Fee: ", fee);
    console.log("UTXO amount: ", utxoAmount);

    const signature = await getSignatureForSweepTx(swapData.txId, swapData.vout, swapData.publicKeyIndex, swapData.htlcAddress, resp.address, lockingScript.scriptBuffer, utxoAmount, fee);

    let psbt = new bitcoin.Psbt({
        network: NETWORK
    });

    psbt.addInput({
        hash: swapData.txId,
        index: swapData.vout,
        witnessUtxo: {
            script: bitcoin.address.toOutputScript(swapData.htlcAddress, NETWORK),
            value: utxoAmount
        },
        value: utxoAmount
    });

    psbt.addOutput({
        address: resp.address,
        value: utxoAmount - fee
    });

    let witnessScript = "04"; //Data pushes

    witnessScript += (signature.length/2).toString(16).padStart(2, "0"); //Signature len
    witnessScript += signature;

    witnessScript += "20"; // Secret len
    witnessScript += secretBuffer.toString("hex"); //Secret

    witnessScript += "0101"; // for OP_IF

    witnessScript += lockingScript.scriptBuffer.length.toString(16).padStart(2, "0"); //Script len
    witnessScript += lockingScript.scriptBuffer.toString("hex");

    psbt.finalizeInput(0, () => {
        return {
            finalScriptWitness: Buffer.from(witnessScript, "hex")
        }
    });

    const tx = psbt.extractTransaction();

    const rawTx = tx.toHex();

    const txId = await lncli.broadcastChainTransaction({
        lnd,
        transaction: rawTx
    });

    console.log("Broadcasted sweep tx: ", txId);

}

function generateLockingScript(csv_delta, hash, intermediaryKey, offererKey) {

    if(csv_delta<0) {
        throw new Error("Invalid csv delta");
    }

    let script = "5187"; //PUSH_1 OP_EQUAL

    script += "63"; //OP_IF

    script += "a8"; //OP_SHA256
    script += "20"+hash.toString("hex"); //PUSH_32 <hash>
    script += "88"; //OP_EQUALVERIFY
    script += "21"+intermediaryKey; //PUSH_33 <our key>

    script += "67"; //OP_ELSE

    if(csv_delta<17) {
        if(csv_delta===0) {
            script += "00";
        } else {
            script += (csv_delta + 0x50).toString(16).padStart(2, "0"); //PUSH_<csv>
        }
    } else {
        let csvDeltaHex = csv_delta.toString(16);
        const csvDeltaLen = Math.ceil(csvDeltaHex.length/2);
        csvDeltaHex = csvDeltaHex.padStart(csvDeltaLen*2, "0");
        script += csvDeltaLen.toString(16).padStart(2, "0")+csvDeltaHex; //PUSH_x <csv>
    }
    script += "b2"; //OP_CSV
    script += "75"; //OP_DROP
    script += "21"+offererKey; //PUSH_33 <payee's key>

    script += "68"; //OP_ENDIF

    script += "ac"; //OP_CHECKSIG

    const scriptBuffer = Buffer.from(script, "hex");
    const scriptAsm = bitcoin.script.toASM(scriptBuffer);

    const scriptHash = crypto.createHash("sha256").update(scriptBuffer).digest();

    const payment = bitcoin.payments.p2wsh({
        hash: scriptHash,
        network: NETWORK
    });

    const address = payment.address;

    console.log("Computed p2wsh address: ", address);

    return {
        address,
        scriptHash,
        scriptBuffer,
        scriptAsm
    };

}

async function setupBTCtoSOL() {

    //Schedule a process to automatically claim outdated swaps and catch possible missed settlements
    await setupBTCtoSOLRefunder();

    //Run expressjs server listening for requests to generate invoices using provided payment hash, create hodl invoice
    const app = express();

    app.use(cors());
    app.use(express.json());

    app.post('/getInvoiceStatus', async (req, res) => {

        try {
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

            const swapData = swaps[req.body.paymentHash];

            if(swapData==null) {
                res.status(200).json({
                    code: 10001,
                    msg: "Expired/canceled"
                });
                return;
            }

            if(swapData.state===2) {
                //Committed
                res.status(200).json({
                    code: 10000,
                    msg: "Success"
                });
                return;
            }

            if(swapData.state===1) {
                //Pricing determined
                res.status(200).json({
                    code: 10000,
                    msg: "Success"
                });
                return;
            }

            //Check if that address received some transaction that is already confirmed
            const utxos = await new Promise((resolve, reject) => {
                console.log("Address: ", [swapData.htlcAddress]);
                btcRpc.listUnspent(0,9999999,[swapData.htlcAddress], true, {
                    minimumAmount: MIN_AMOUNT_BTCtoSOL.divide(new bigDecimal(100000000)).getValue()
                },(err, info) => {
                    if(err) {
                        reject(err);
                        return;
                    }
                    resolve(info.result);
                });
            });

            if(utxos.length===0) {
                res.status(200).json({
                    code: 10003,
                    msg: "Yet unpaid"
                });
                return;
            }

            const utxo = utxos[0];

            const amountBD = new bigDecimal(utxo.amount).multiply(new bigDecimal(100000000));

            const {tokens_per_vbyte} = await lncli.getChainFeeRate({lnd, confirmation_target: 2});

            let networkFee = new bigDecimal(tokens_per_vbyte).multiply(new bigDecimal(HTLC_SWEEP_VBYTES)).ceil();

            const swapFee = BASE_FEE.add(amountBD.multiply(FEE)).floor();

            if(swapData.expectedNetworkFee.compareTo(networkFee)>0) {
                networkFee = swapData.expectedNetworkFee;
            }

            if(utxo.confirmations<CONFIRMATIONS) {
                res.status(200).json({
                    code: 10005,
                    msg: "Awaiting confirmations",
                    data: {
                        confirmations: utxo.confirmations,
                        requiredConfirmations: CONFIRMATIONS,
                        txId: utxo.txid,
                        vout: utxo.vout,
                        amount: amountBD.getValue(),

                        swapFee: swapFee.getValue(),
                        networkFee: networkFee.getValue()
                    }
                });
                return;
            }

            res.status(200).json({
                code: 10000,
                msg: "Success"
            });
        } catch (e) {
            console.error(e);
        }

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

        const swapData = swaps[req.body.paymentHash];

        if(swapData==null) {
            res.status(200).json({
                code: 10001,
                msg: "Expired/canceled"
            });
            return;
        }

        if(swapData.state===2) {
            //Committed
            res.status(200).json({
                code: 10004,
                msg: "Invoice already committed"
            });
            return;
        }

        if(swapData.state===0) {
            //Check if that address received some transaction that is already confirmed
            const utxos = await new Promise((resolve, reject) => {
                btcRpc.listUnspent(0,9999999,[swapData.htlcAddress], true, {
                    minimumAmount: MIN_AMOUNT_BTCtoSOL.divide(new bigDecimal(100000000)).getValue()
                },(err, info) => {
                    if(err) {
                        reject(err);
                        return;
                    }
                    resolve(info.result);
                });
            });

            if(utxos.length===0) {
                res.status(200).json({
                    code: 10003,
                    msg: "Yet unpaid"
                });
                return;
            }

            const utxo = utxos[0];

            const amountBD = new bigDecimal(utxo.amount).multiply(new bigDecimal(100000000));

            const {tokens_per_vbyte} = await lncli.getChainFeeRate({lnd, confirmation_target: 2});

            let networkFee = new bigDecimal(tokens_per_vbyte).multiply(new bigDecimal(HTLC_SWEEP_VBYTES)).ceil();

            const swapFee = BASE_FEE.add(amountBD.multiply(FEE)).floor();

            if(swapData.expectedNetworkFee.compareTo(networkFee)>0) {
                networkFee = swapData.expectedNetworkFee;
            }

            if(utxo.confirmations<CONFIRMATIONS) {
                res.status(200).json({
                    code: 10005,
                    msg: "Awaiting confirmations",
                    data: {
                        confirmations: utxo.confirmations,
                        requiredConfirmations: CONFIRMATIONS,
                        txId: utxo.txid,
                        vout: utxo.vout,
                        amount: amountBD.getValue(),

                        swapFee: swapFee.getValue(),
                        networkFee: networkFee.getValue()
                    }
                });
                return;
            }

            console.log("[BTC->SOL: LN.Held] processing UTXO: ", utxo);

            const receivedAmount = amountBD.subtract(swapFee).subtract(networkFee);

            const blockDelta = new bigDecimal(swapData.csvDelta-utxo.confirmations);

            console.log("[BTC->SOL: SOL.offerer_payReq] block delta: ", blockDelta.getValue());

            const expiryTimeout = blockDelta.multiply(BITCOIN_BLOCKTIME.divide(SAFETY_FACTOR, 0)).subtract(GRACE_PERIOD);

            console.log("[BTC->SOL: SOL.offerer_payReq] expiry timeout: ", expiryTimeout.getValue());

            if(expiryTimeout.compareTo(new bigDecimal(0))<0) {
                //TODO: Do a cooperative close of the bitcoin HTLC here with SIGHASH_NONE | ANYONE_CAN_PAY signature
                console.error("[BTC->SOL: SOL.offerer_payReq] Expire time is lower than 0");
                res.status(200).json({
                    code: 20002,
                    msg: "Not enough time to reliably process the swap"
                });
                return;
            }

            swapData.token = WBTC_ADDRESS;
            swapData.amount = receivedAmount;
            swapData.expiry = new bigDecimal(Date.now()/1000).add(expiryTimeout).floor();
            swapData.state = 1;
            swapData.committed = false;
            swapData.txId = utxo.txid;
            swapData.vout = utxo.vout;
            swapData.utxoAmount = amountBD;

            await saveSwapData(swapData);
        }

        const tokenAccount = await program.account.userAccount.fetch(userVaultKey);
        const balance = new bigDecimal(tokenAccount.amount.toString(10));
        if(balance.compareTo(swapData.amount)<0) {
            //TODO: Do a cooperative close of the bitcoin HTLC here with SIGHASH_NONE | ANYONE_CAN_PAY signature
            console.error("[BTC->SOL: LN.Held] ERROR Not enough balance on SOL to honor the request");
            res.status(200).json({
                code: 20001,
                msg: "Not enough liquidity"
            });
            return;
        }

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
        messageBuffers[2] = swapData.token.toBuffer();
        messageBuffers[3] = swapData.intermediary.toBuffer();
        messageBuffers[4].writeBigUInt64LE(BigInt(swapData.amount.getValue()));
        messageBuffers[5].writeBigUInt64LE(BigInt(swapData.expiry.getValue()));
        messageBuffers[6] = Buffer.from(swapData.paymentHash, "hex");
        messageBuffers[7].writeUint8(0);
        messageBuffers[8].writeUint16LE(0);
        messageBuffers[9].writeBigUInt64LE(BigInt(authTimeout));

        const messageBuffer = Buffer.concat(messageBuffers);
        const signature = nacl.sign.detached(messageBuffer, _signer.secretKey);

        const sendObj = {};
        sendObj.intermediary = swapData.intermediary.toBase58();
        sendObj.token = swapData.token.toBase58();
        sendObj.expiry = swapData.expiry.getValue();
        sendObj.amount = swapData.amount.getValue();
        sendObj.paymentHash = swapData.paymentHash;

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
        try {
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
                req.body.btcPublicKey==null ||
                typeof(req.body.btcPublicKey)!=="string" ||
                req.body.btcPublicKey.length!==66 ||
                !HEX_REGEX.test(req.body.btcPublicKey)
            ) {
                res.status(400).json({
                    msg: "Invalid request body (btcPublicKey)"
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

            if(swaps[req.body.paymentHash]!=null) {
                res.status(400).json({
                    msg: "Invalid request body (paymentHash - already exists)"
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

            if(amountBD.compareTo(MIN_AMOUNT_BTCtoSOL)<0) {
                res.status(400).json({
                    msg: "Amount too low"
                });
                return;
            }

            if(amountBD.compareTo(MAX_AMOUNT_BTCtoSOL)>0) {
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

            const {index, public_key} = await lncli.getPublicKey({
                family: 1,
                lnd
            });

            const lockingScript = generateLockingScript(SWAP_CSV_DELTA, Buffer.from(req.body.paymentHash, "hex"), public_key, req.body.btcPublicKey);

            console.log("[BTC->SOL: LN.Create] creating locking script: ", lockingScript.scriptAsm);

            console.log("[BTC->SOL: LN.Create] created HTLC address: ", lockingScript.address);

            await new Promise((resolve, reject) => {
                btcRpc.importAddress(bitcoin.address.toOutputScript(lockingScript.address, NETWORK).toString("hex"), lockingScript.address, false, (err) => {
                    if(err) {
                        reject(err);
                        return;
                    }
                    resolve();
                });
            });

            const {tokens_per_vbyte} = await lncli.getChainFeeRate({lnd, confirmation_target: 2});

            const expectedNetworkFee = new bigDecimal(tokens_per_vbyte).multiply(new bigDecimal(HTLC_SWEEP_VBYTES)).multiply(NETWORK_FEE_MULTIPLIER).ceil();

            const swapFee = BASE_FEE.add(amountBD.multiply(FEE)).floor();

            const payInvoiceObject = {
                intermediary: new web3.PublicKey(req.body.address),
                paymentHash: req.body.paymentHash,
                btcPublicKey: req.body.btcPublicKey,
                publicKeyIndex: index,
                publicKey: public_key,
                htlcAddress: lockingScript.address,
                csvDelta: SWAP_CSV_DELTA,
                expectedNetworkFee: expectedNetworkFee,
                state: 0
            };

            await saveSwapData(payInvoiceObject);

            res.status(200).json({
                msg: "Success",
                data: {
                    address: lockingScript.address,
                    publicKey: public_key,
                    csvDelta: SWAP_CSV_DELTA,
                    networkFee: expectedNetworkFee.getValue(),
                    swapFee: swapFee.getValue()
                }
            });
        } catch (e) {
            console.error(e);
        }
    });

    app.listen(4002);

    console.log("[BTC->SOL: Webserver] running on port 4002");

}

async function processLogBTCtoSOL({events, instructions}) {

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
                savedSwap.state = 2;
            } else {
                console.error("[BTC->SOL: SOL.init] No swap submitted");
            }

            const usedNonce = ix.data.nonce.toNumber();
            if(usedNonce>getNonce()) {
                await saveNonce(usedNonce);
            }

            if(savedSwap!=null) {
                await saveSwapData(savedSwap);
            }
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

            if(swaps[paymentHashHex]==null) {
                console.log("[BTC->SOL: SOL.Claimed] No swap found");
                continue;
            }

            try {
                await sweepHTLC(paymentHash, secret);
                console.log("[BTC->SOL: SOL.Claimed] Invoice settled, id: ", paymentHashHex);
            } catch (e) {
                console.error(e);
                console.error("[BTC->SOL: SOL.Claimed] FATAL Cannot settle hodl invoice id: "+paymentHashHex+" secret: ", secretHex);
                throw e;
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
                //TODO: We can do a cooperative close of HTLC here
                console.log("[BTC->SOL: SOL.Refunded] Invoice cancelled, because was refunded, id: ", paymentHash);
            } catch (e) {
                console.error("[BTC->SOL: SOL.Refunded] Cannot cancel hodl invoice id: ", paymentHash);
            }

            await removeSwapData(paymentHash);

        }
    }
}

module.exports = {
    setupBTCtoSOL,
    processLogBTCtoSOL,
    loadBTCtoSOL
};