require('dotenv').config();
const fs = require('fs').promises;
const anchor = require("@project-serum/anchor");
const web3 = require("@solana/web3.js");
const programIdl = require("./programIdl");

const {_client, AUTHORITY_SEED} = require("./constants");

const {processLogSOLtoBTCLN, setupSOLtoBTCLN, loadSOLtoBTCLN} = require("./soltobtcln");
const {processLogBTCLNtoSOL, setupBTCLNtoSOL, loadBTCLNtoSOL} = require("./btclntosol");
const {processLogSOLtoBTC, setupSOLtoBTC, loadSOLtoBTC} = require("./soltobtc");
const {processLogBTCtoSOL, setupBTCtoSOL, loadBTCtoSOL} = require("./btctosol");

/*
Test payment request:
[
  "0x54cBF16dBC0457AEC34E86b18e307b30C97c38d3",
  "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
  303,
  "0x6C6E6263337531703365786C71747070356D70377A32753936786C387A3036367474753439707163766A7630386B7639396D3566376565663239613934636C7234363973716471753261736B636D7239777373783765337132647368676D6D6E6470357363717A70677871797A3576717370353832366B68726C676D7A736879633377656568336768726A7A77636A3938386A6365366536366D353261746A6B686D6D63356E73397179797373713875797972327174676B66747874303568647A3765327978357A6A7578326A7937336B756577366B63776C326A323665306336396A7334686A6832746D307A7A6A663033723765356B68667361336E707679747A7A763479307078327533797A64666564393971716A3665646A72",
  3,
  1670696065
]
 */

const MAX_FETCH_BLOCKS = 2500;
const LOG_FETCH_INTERVAL = 5*1000;

const nameMappedInstructions = {};
for(let ix of programIdl.instructions) {
    nameMappedInstructions[ix.name] = ix;
}

const coder = new anchor.BorshCoder(programIdl);
const program = new anchor.Program(programIdl, programIdl.metadata.address, _client);
const eventParser = new anchor.EventParser(program.programId, coder);

function decodeInstructions(transactionMessage) {

    const instructions = [];

    for(let ix of transactionMessage.instructions) {
        if(transactionMessage.accountKeys[ix.programIdIndex].equals(program.programId)) {
            const parsedIx = coder.instruction.decode(ix.data, 'base58');
            const accountsData = nameMappedInstructions[parsedIx.name];
            if(accountsData!=null && accountsData.accounts!=null) {
                parsedIx.accounts = {};
                for(let i=0;i<accountsData.accounts.length;i++) {
                    parsedIx.accounts[accountsData.accounts[i].name] = transactionMessage.accountKeys[ix.accounts[i]]
                }
            }
            instructions.push(parsedIx);
        } else {
            instructions.push(null);
        }
    }

    return instructions;

}

async function getLastBlockHeight() {
    try {
        const txt = await fs.readFile("blockheight.txt");
        return txt.toString();
    } catch (e) {
        return null;
    }
}

async function saveLastBlockHeight(blockheight) {
    await fs.writeFile("blockheight.txt", ""+blockheight);
}

const limit = 500;

function setupListener() {

    return new Promise((resolve, reject) => {
        const check = async () => {
            const lastSignature = await getLastBlockHeight();

            let signatures = null;

            if(lastSignature==null) {
                signatures = await _client.connection.getSignaturesForAddress(program.programId, {
                    limit: 1
                }, "confirmed");
                if(signatures.length>0) {
                    await saveLastBlockHeight(signatures[0].signature);
                }
                return;
            }

            let fetched = null;
            while(fetched==null || fetched.length===limit) {
                if(signatures==null) {
                    fetched = await _client.connection.getSignaturesForAddress(program.programId, {
                        until: lastSignature,
                        limit
                    }, "confirmed");
                } else {
                    fetched = await _client.connection.getSignaturesForAddress(program.programId, {
                        before: signatures[signatures.length-1].signature,
                        until: lastSignature,
                        limit
                    }, "confirmed");
                }
                if(signatures==null) {
                    signatures = fetched;
                } else {
                    fetched.forEach(e => signatures.push(e));
                }
            }

            for(let i=signatures.length-1;i>=0;i--) {
                console.log("Process signature: ", signatures[i].signature);
                const transaction = await _client.connection.getTransaction(signatures[i].signature, {
                    commitment: "confirmed"
                });
                if(transaction.meta.err==null) {
                    //console.log("Process tx: ", transaction.transaction);
                    //console.log("Decoded ix: ", decodeInstructions(transaction.transaction.message));
                    const instructions = decodeInstructions(transaction.transaction.message);
                    const parsedEvents = eventParser.parseLogs(transaction.meta.logMessages);

                    const events = [];
                    for(let event of parsedEvents) {
                        events.push(event);
                    }

                    console.log("Instructions: ", instructions);
                    console.log("Events: ", events);

                    await processLogSOLtoBTCLN({
                        events,
                        instructions
                    });
                    await processLogSOLtoBTC({
                        events,
                        instructions
                    });
                    await processLogBTCLNtoSOL({
                        events,
                        instructions
                    });
                    await processLogBTCtoSOL({
                        events,
                        instructions
                    });
                }
            }

            if(resolve!=null) {
                resolve();
                resolve = null;
            }

            if(signatures.length>0) {
                await saveLastBlockHeight(signatures[0].signature);
            }

        }

        check();
        setInterval(check, LOG_FETCH_INTERVAL);
    });
}


async function main() {

    await loadSOLtoBTCLN();
    await loadBTCLNtoSOL();
    await loadSOLtoBTC();
    await loadBTCtoSOL();

    await setupSOLtoBTCLN();
    await setupSOLtoBTC();
    await setupListener();
    await setupBTCLNtoSOL();
    await setupBTCtoSOL();

}

main();