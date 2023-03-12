const fs = require("fs");
const web3 = require("@solana/web3.js");

const keypair = web3.Keypair.generate();

const address = keypair.publicKey.toBase58();

fs.appendFileSync(".env",
    "SOL_PRIVKEY=\""+Buffer.from(keypair.secretKey).toString("hex")+"\"\n"+
    "SOL_ADDRESS=\""+address+"\"\n");

console.log("Generated address: "+address);