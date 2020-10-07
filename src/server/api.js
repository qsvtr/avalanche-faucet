const {CONFIG, avm, bintools} = require('./ava');
const axios = require('axios').default;
const { CONFIG_C} = require("./eth");
//
const AVA = require('./ava');
var router = require('express').Router();
const URLPayload = require("avalanche/dist/utils/payload").URLPayload
const PlatformVMAPI = require("avalanche/dist/apis/platformvm/api").PlatformVMAPI
const BN = require('bn.js');
const platform = new PlatformVMAPI(AVA.ava, '/ext/bc/P');
const AVMConstants = require("avalanche/dist/apis/avm").AVMConstants
const OperationTx = require("avalanche/dist/apis/avm").OperationTx
const SECPTransferInput = require("avalanche/dist/apis/avm").SECPTransferInput
const SECPTransferOutput = require("avalanche/dist/apis/avm").SECPTransferOutput
const TransferableInput = require("avalanche/dist/apis/avm").TransferableInput
const TransferableOperation = require("avalanche/dist/apis/avm").TransferableOperation
const TransferableOutput = require("avalanche/dist/apis/avm").TransferableOutput
const UnsignedTx = require("avalanche/dist/apis/avm").UnsignedTx
const NFTMintOperation = require("avalanche/dist/apis/avm").NFTMintOperation
const OutputOwners = require("avalanche/dist/common").OutputOwners
const MongoClient = require("mongodb")

const blockchainID = bintools.cb58Decode(avm.getBlockchainID())
const xKeychain = avm.keyChain()
xKeychain.importKey(CONFIG.PK_X)
const xAddresses = avm.keyChain().getAddresses();
const xAddressStrings = avm.keyChain().getAddressStrings()


const locktime = new BN(0)
const threshold = 1
const mstimeout = 2000
const mongodb_url = "mongodb://localhost:27017/";

router.get('/howmuch', (req, res) => {
    res.json({
        dropSizeX: CONFIG.DROP_SIZE,
        dropSizeC: CONFIG_C.DROP_SIZE
    });
});


router.post('/token', (req, res) => {
    let address = req.body["address"];
    let captchaResponse = req.body["g-recaptcha-response"];

    // Return error if captcha doesnt exist
    if(!captchaResponse){
        res.json({
            status: 'error',
            message: 'Invalid Captcha'
        });
        return;
    }

    let params = new URLSearchParams();
    params.append('secret', CONFIG.CAPTCHA_SECRET );
    params.append('response', captchaResponse );


    // Verify Captcha
    axios({
        method: 'post',
        url: "https://www.google.com/recaptcha/api/siteverify",
        data: params,
    }).then( async (axios_res) => {
        // console.log(axios_res.data);
        let data = axios_res.data;
        // If captcha succesfull send tx
        if(data.success){

            // P CHAIN
            if(address[0] === 'P'){
                // check and mint NFT
                isLegit(address).then(response => {
                    res.json({
                        status: response.status,
                        message: response.message
                    });
                })

            }
        }else{
            res.json({
                status: 'error',
                message: 'Invalid Captcha'
            });
        }
    });
});

const addValidatorToDatabase = async (Paddress) => {
    MongoClient.connect(mongodb_url, {useNewUrlParser: true, useUnifiedTopology: true}, (err, client) => {
        if(err) throw err;
        let database = client.db('nft_faucet_1');
        database.collection("validators").insertOne({address: Paddress}, function(err) {
            if (err) throw err;
            client.close();
        });
    })
}

const checkValidatorInDatabase = async (Paddress) => {
    return new Promise((resolve) => {
        MongoClient.connect(mongodb_url, {useNewUrlParser: true, useUnifiedTopology: true}, (err, client) => {
            if (err) throw err;
            let database = client.db('nft_faucet_1');
            return database.collection("validators").find({address: Paddress}).toArray(function (err, result) {
                if (err) throw err;
                if (result.length > 0) {
                    resolve(true)
                } else {
                    resolve(false)
                }
                client.close(); // necessary ?
            });
        });
    });
}

// from https://github.com/tbrunain/avalanche-nft-creation
const sleep = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms))
}
async function substractFee(outs, assetID, fee) {
    let result = await avm.getBalance(xAddressStrings[0], bintools.cb58Encode(assetID))
    let balance = new BN(result.balance)
    let avaxAmount = balance.sub(fee)
    let secpOutput = new SECPTransferOutput(avaxAmount, xAddresses, locktime, threshold)
    let transferableOutput = new TransferableOutput(assetID, secpOutput)
    outs.push(transferableOutput)
}
async function selectUtxoWithEnoughAvax() {
    // We fetch the UTXOs of the current address
    let {utxos: utxoSet} = await avm.getUTXOs(xAddressStrings, 'X', 2048)

    // Here we select one UTXO where there is enough AVAX to pay for the fee .
    let utxos = utxoSet.getAllUTXOs().filter(u => u.getOutput().getTypeName() === 'SECPTransferOutput' && u.getOutput().getOutputID() === 7)
    let utxo
    for (let aUtxo of utxos) {
        let output = aUtxo.getOutput()
        let amt = output.getAmount().clone()
        if (amt > new BN(100000000)) {
            utxo = aUtxo
            break;
        }
    }
    return utxo;
}
const getUTXOIDs = (utxoSet, txid, outputType = AVMConstants.SECPMINTOUTPUTID) => {
    const utxoids = utxoSet.getUTXOIDs()
    let result = []
    for (let index = 0; index < utxoids.length; ++index) {
        if (utxoids[index].indexOf(txid.slice(0, 10)) !== -1 && utxoSet.getUTXO(utxoids[index]) && utxoSet.getUTXO(utxoids[index]).getOutput().getOutputID() === outputType) {
            if (result.length === 0) {
                result.push(utxoids[index])
            }
        }
    }
    return result
}
async function mintNFT(assetID, fee, groupID, id, memo, receiverAddress) {
    let ins = []
    let outs = []

    // Again here we fetch the fee, create the output which will contain the balance - fee .
    await substractFee(outs, assetID, fee);

    // ToDo Still no clue what 'groupID' represent exactly here .
    console.log(`PAYLOAD - ${bintools.bufferToB58(memo)}`)
    const nftMintOperation = new NFTMintOperation(groupID, memo, [new OutputOwners([bintools.stringToAddress(receiverAddress)], locktime, threshold)]) //

    let {utxos: utxoSet} = await avm.getUTXOs(xAddressStrings)

    let utxo = await selectUtxoWithEnoughAvax(); // représente un transfert d'AVAX

    let output = utxo.getOutput()
    let amt = output.getAmount().clone()
    let txid = utxo.getTxID()
    let outputidx = utxo.getOutputIdx()

    let secpInput = new SECPTransferInput(amt)
    secpInput.addSignatureIdx(0, xAddresses[0])
    // We create the transferable input, pointing to the Tx where we have enough AVAX for the fee .
    let transferableInput = new TransferableInput(txid, outputidx, assetID, secpInput)
    ins.push(transferableInput)

    let utxoids = getUTXOIDs(utxoSet, id, AVMConstants.NFTMINTOUTPUTID)

    utxo = utxoSet.getUTXO(utxoids[0])
    let out = utxo.getOutput()
    let spenders = out.getSpenders(xAddresses)

    spenders.forEach((spender) => {
        const idx = out.getAddressIdx(spender)
        nftMintOperation.addSignatureIdx(idx, spender)
    })
    let ops = []

    let transferableOperation = new TransferableOperation(utxo.getAssetID(), utxoids, nftMintOperation)
    ops.push(transferableOperation)

    let operationTx = new OperationTx(CONFIG.AVA_NETWORK_ID, blockchainID, outs, ins, Buffer.from(CONFIG.ASSET_NAME), ops)
    let unsignedTx = new UnsignedTx(operationTx)
    let tx = unsignedTx.sign(xKeychain)
    let mint_tx_id = await avm.issueTx(tx);
    let tx_status = await avm.getTxStatus(mint_tx_id);
    while (tx_status !== 'Accepted') {
        tx_status = await avm.getTxStatus(mint_tx_id);
    }
    await sleep(mstimeout)
    return mint_tx_id;
}

const isLegit =  async (Paddress) => {
    return new Promise(async (resolve) => {
        const nft_id = CONFIG.NFT_ID
        const assetID = await avm.getAVAXAssetID()
        const trffee = avm.getTxFee()
        const groupID = 42
        const res = await platform.getCurrentValidators()
        const memo = (new URLPayload(CONFIG.URL_IMG)).getPayload()
        const validators = res['validators'];
        let found = false;
        for (let i = 0; i < validators.length; i++) {
            // console.log("test")
            if (validators[i].rewardOwner.addresses[0] === Paddress && !found) {
                found = true
                // console.log(`address ${Paddress} found with NodeID=${validators[i].nodeID}`)
                await checkValidatorInDatabase(Paddress).then(async (res) => {
                    if (res) {
                        resolve({status: "info", message: "The address has already received the NFT"})
                    } else {
                        await addValidatorToDatabase(Paddress)
                        const xAddress = Paddress.replace(Paddress.charAt(0), "X")
                        const mint_tx_id = await mintNFT(assetID, trffee, groupID, nft_id, memo, xAddress);
                        resolve({status: "success", message: mint_tx_id})
                    }
                }, function (err) {
                    console.error('The promise was rejected', err, err.stack);
                });
            }
        }
        resolve({status: "info", message: "The address does not belong to a validator"})
    })
}


module.exports = router;
