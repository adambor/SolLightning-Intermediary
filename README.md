# SolLightning intermediary

An off-chain app handling BTC <-> Solana cross-chain swaps, utilizing [SolLightning-program](https://github.com/adambor/SolLightning-program) Solana on-chain program.

Principle of operation is described in depth [here](https://github.com/adambor/SolLightning-readme/blob/main/sol-submarine-swaps.md) (for lightning network swaps) and [here](https://github.com/adambor/SolLightning-readme/blob/main/sol-onchain-swaps.md) (for bitcoin on-chain swaps)

__IMPORTANT NOTE: This is app is not yet safe to use, may contain bugs, and uncovered edge-cases, therefore it is only recommended to be used on Bitcoin testnet and Solana devnet__ 

## Requirements
* bitcoind node
* lnd node (Install instructions [here](https://github.com/lightningnetwork/lnd/blob/master/docs/INSTALL.md))
* nodejs
* npm

## Installation
### Installing bitcoind
1. Download latest version from [here](https://bitcoincore.org/en/download/) or [build from source](https://baloian.medium.com/how-to-setup-and-run-a-bitcoin-full-node-on-ubuntu-a106fb86dbb3)
2. Use the configuration file [bitcoin.conf](https://github.com/adambor/SolLightning-Intermediary/blob/main/bitcoind/bitcoin.conf)
3. Run the bitcoind with the configuration file: ```bitcoind -conf=<path/to/bitcoin.conf>```
4. Wait till bitcoind finishes with IBD (initial block download), should take no more than a few hours for testnet on a regular PC with good internet connection
5. Create a new wallet in bitcoind: ```bitcoin-cli -testnet -conf=<path/to/bitcoin.conf> createwallet test true false "" false false true false```
6. Set the configured rpc ip, port, username and password in _.env file (not necessary if you used provided [bitcoin.conf](https://github.com/adambor/SolLightning-Intermediary/blob/main/bitcoind/bitcoin.conf))

### Installing lnd
1. Download latest version from [here](https://github.com/lightningnetwork/lnd/releases) or [build from source](https://github.com/lightningnetwork/lnd/blob/master/docs/INSTALL.md#installing-a-binary-release)
2. Use the provided configuration file [lnd.conf](https://github.com/adambor/SolLightning-Intermediary/blob/main/lnd/lnd.conf)
3. Either place the lnd.conf file in ~/.lnd/ folder or run lnd with a --configfile argument: ```lnd --configfile=<path/to/lnd.conf>```
4. Wait for the lnd to startup. It should then ask you to create a wallet.
5. Create a new wallet with: ```lncli -n testnet create```
6. Save password you used to create a wallet to some known file (e.g. ~/lnd-pass.txt), and add ```wallet-unlock-password-file=<path/to/password-file>``` option to lnd.conf, like so:
    ```
    [Application Options]
    tlsextraip=127.0.0.1
    wallet-unlock-password-file=path/to/password-file
    ```
7. Get the certificate by  ```base64 --wrap=0 ~/.lnd/tls.cert``` and copy the output to LN_CERT field in _.env file
8. Get the admin macaroon by  ```base64 --wrap=0 ~/.lnd/data/chain/bitcoin/mainnet/admin.macaroon``` and copy the output to LN_MACAROON field in _.env file
9. Set the ip and port in the _.env (not needed if using provided [lnd.conf](https://github.com/adambor/SolLightning-Intermediary/blob/main/lnd/lnd.conf))
10. Get the bitcoin address ```lncli -n testnet newaddress p2wkh```
11. Get some testnet bitcoin to that address through one of the faucets:
    * [coinfaucet.eu](https://coinfaucet.eu/en/btc-testnet)
    * [bitcoinfaucet.uo1.net](https://bitcoinfaucet.uo1.net/)
    * [testnet-faucet.com](https://testnet-faucet.com/btc-testnet/)
    * [onchain.io](https://onchain.io/bitcoin-testnet-faucet)
12. Connect to a well connected bitcoin lightning node, you can find the list [here](https://1ml.com/testnet/node?order=capacity). Pick a node and copy its connection string (should look like so: 038863cf8ab91046230f561cd5b386cbff8309fa02e3f0c3ed161a3aeb64a643b9@203.132.94.196:9735). Then use ```lncli -n testnet connect <connection string>``` to connect to that node.
13. Open a channel with the node you connected to. Take the public key from the connection string (the part before '@', e.g.: 038863cf8ab91046230f561cd5b386cbff8309fa02e3f0c3ed161a3aeb64a643b9). Open a channel with ```lncli -n testnet openchannel <node public key> <amount> <push_amount>```. Be sure to push half of your channel's balance to the other node so you can receive, e.g. ```lncli -n testnet openchannel <node public key> 100000 50000```
14. Wait for the channel to be established, you can monitor pending channels with: ```lncli -n testnet pendingchannels```

### Installing btcrelay
Instructions available [here](https://github.com/adambor/BTCRelay-Sol-Offchain). Skip steps 2.-4. as you already have bitcoind setup and running.

### Installing sollightning
1. Install necessary npm packages: ```npm install```
2. Rename _.env file to .env
3. Generate a new solana keypair: ```npm run genKey```
4. Airdrop some devnet tokens to your newly generated solana wallet: ```npm run airdrop```
5. Create the WBTC token on devnet: ```npm run createToken```
6. Mint some WBTC token to your new keypair: ```npm run mint <amount to mint in satoshis>```
7. You can also mint some WBTC tokens to your phantom wallet: ```npm run mint <amount to mint in satoshis> <wallet address>```
8. Deposit your WBTC to the program ```npm run deposit <amount to deposit in satoshis>```
9. Be sure that bitcoind, lnd and btcrelay are running before starting the app.
10. Run the app with: ```npm start```
