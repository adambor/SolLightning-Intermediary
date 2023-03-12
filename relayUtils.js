const web3 = require("@solana/web3.js");
const anchor = require("@project-serum/anchor");
const btcRelayProgramIdl = require("./btcrelay/programIdl");
const crypto = require("crypto");

const {_client} = require("./constants");

const btcRelayProgram = new anchor.Program(btcRelayProgramIdl, btcRelayProgramIdl.metadata.address, _client);
const btcRelayCoder = new anchor.BorshCoder(btcRelayProgramIdl);
const btcRelayEventParser = new anchor.EventParser(btcRelayProgram.programId, btcRelayCoder);

const HEADER_SEED = "header";
const BTC_RELAY_STATE_SEED = "state";

const mainStateKey = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(BTC_RELAY_STATE_SEED)],
    btcRelayProgram.programId
)[0];

function getHeaderTopic(hash) {
    return web3.PublicKey.findProgramAddressSync(
        [Buffer.from(HEADER_SEED), hash],
        btcRelayProgram.programId
    )[0];
}

const limit = 500;

async function retrieveBlockLog(blockhash, requiredBlockheight) {
    //Retrieve the log
    let storedHeader = null;

    let lastSignature = null;

    const mainState = await btcRelayProgram.account.mainState.fetch(mainStateKey);

    if(mainState.blockHeight < requiredBlockheight) {
        //Btc relay not synchronized to required blockheight
        return null;
    }

    const storedCommitments = new Set();
    mainState.blockCommitments.forEach(e => {
        storedCommitments.add(Buffer.from(e).toString("hex"));
    });

    const blockHashBuffer = Buffer.from(blockhash, 'hex').reverse();
    const topicKey = getHeaderTopic(blockHashBuffer);

    while(storedHeader==null) {
        let fetched;
        if(lastSignature==null) {
            fetched = await _client.connection.getSignaturesForAddress(topicKey, {
                limit
            }, "confirmed");
        } else {
            fetched = await _client.connection.getSignaturesForAddress(topicKey, {
                before: lastSignature,
                limit
            }, "confirmed");
        }
        if(fetched.length===0) throw new Error("Block cannot be fetched");
        lastSignature = fetched[fetched.length-1].signature;
        for(let data of fetched) {
            const tx = await _client.connection.getTransaction(data.signature, {
                commitment: "confirmed"
            });
            if(tx.meta.err) continue;

            const events = btcRelayEventParser.parseLogs(tx.meta.logMessages);

            for(let log of events) {
                if(log.name==="StoreFork" || log.name==="StoreHeader") {
                    if(blockHashBuffer.equals(Buffer.from(log.data.blockHash))) {
                        const commitHash = Buffer.from(log.data.commitHash).toString("hex");
                        if(storedCommitments.has(commitHash)) {
                            storedHeader = log.data.header;
                            break;
                        }
                    }
                }
            }

            if(storedHeader!=null) break;
        }
    }

    return storedHeader;
}

function dblSha256(buffer) {
    return crypto.createHash("sha256").update(
        crypto.createHash("sha256").update(buffer).digest()
    ).digest()
}

function calcTreeWidth(height, nTxs) {
    return (nTxs+(1 << height)-1) >> height;
}

function computePartialHash(height, pos, txIds) {

    if(height===0) {
        return txIds[pos];
    } else {
        const left = computePartialHash(height-1, pos*2, txIds);
        let right;
        if(pos*2+1 < calcTreeWidth(height-1, txIds.length)) {
            right = computePartialHash(height-1, pos*2+1, txIds);
        } else {
            right = left;
        }

        return dblSha256(Buffer.concat([
            left, right
        ]));
    }

}

async function getTransactionMerkle(rpc, txId, blockhash) {
    const block = await new Promise((resolve, reject) => {
        rpc.getBlock(blockhash, 1, (err, res) => {
            if(err || res.error) {
                reject(err || res.error);
                return;
            }
            resolve(res.result);
        })
    });

    console.log(block);

    const position = block.tx.indexOf(txId);
    const txIds = block.tx.map(e => Buffer.from(e, "hex").reverse());

    const reversedMerkleRoot = Buffer.from(block.merkleroot, "hex").reverse();

    const proof = [];
    let n = position;
    while(true) {
        if(n%2===0) {
            //Left
            const treeWidth = calcTreeWidth(proof.length, txIds.length);
            if(treeWidth===1) {
                break;
            } else if(treeWidth<=n+1) {
                proof.push(computePartialHash(proof.length, n, txIds));
            } else {
                proof.push(computePartialHash(proof.length, n+1, txIds));
            }
        } else {
            //Right
            proof.push(computePartialHash(proof.length, n-1, txIds));
        }
        n = Math.floor(n/2);
    }

    const blockHeight = block.height;

    return {
        reversedTxId: Buffer.from(txId, "hex").reverse(),
        pos: position,
        merkle: proof,
        blockheight: blockHeight
    }

}

async function createVerifyIx(signer, reversedTxId, confirmations, position, reversedMerkleProof, committedHeader) {
    const verifyIx = await btcRelayProgram.methods
        .verifyTransaction(
            reversedTxId,
            confirmations,
            position,
            reversedMerkleProof,
            committedHeader
        )
        .accounts({
            signer: signer.publicKey,
            mainState: mainStateKey
        })
        .signers([signer])
        .instruction();

    return verifyIx;
}

module.exports = {
    getTransactionMerkle,
    retrieveBlockLog,
    createVerifyIx
};