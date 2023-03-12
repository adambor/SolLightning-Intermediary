const fs = require('fs').promises;

let nonce;

async function loadNonce() {
    try {
        const txt = await fs.readFile("nonce.txt");
        nonce = parseInt(txt.toString());
    } catch (e) {
        nonce = 0;
    }
}

async function saveNonce(_nonce) {
    nonce = _nonce;
    await fs.writeFile("nonce.txt", ""+_nonce);
}

function getNonce() {
    return nonce;
}

module.exports ={
    loadNonce,
    saveNonce,
    getNonce
};