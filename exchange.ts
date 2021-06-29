import axios from "axios";
import crypto from "crypto";
import WebSocket from 'ws';
import process from 'process';
import Big from 'big.js';
import { Currency } from "./types";

Big.RM = Big.roundDown

const sourceSyncNode: string = process.env.SOURCE_NODE ?? "https://krist.ceriat.net";
const targetSyncNode: string = process.env.TARGET_NODE ?? "https://tenebra.lil.gay";
const sourcePrivKey: string = process.env.PRIVATE_KEY ?? "123";
const targetPrivKey: string = process.env.PRIVATE_KEY ?? "123";

const currencies: Record<string, Currency> = {
  "tenebra": {
    syncNode: targetSyncNode,
    privateKey: targetPrivKey,
    decimals: 0,
    name: "exchange",
    exchange: {}
  },
  "krist": {
    syncNode: sourceSyncNode,
    privateKey: sourcePrivKey,
    decimals: 0,
    name: "portal",
    exchange: {
      tenebra: new Big("10.0")
    }
  }
}

//Thanks Lemmmy for this code i stole (for all of address generation)

function sha256(...inputs: any[]) {
    let hash = crypto.createHash("sha256");
    for (const input of inputs) {
      hash = hash.update(input instanceof Uint8Array ? input : input.toString());
    }
    return hash.digest("hex");
  };
  
function hexToBase36(input: number) {
    for (let i= 6; i <= 251; i += 7) {
      if (input <= i) {
        if (i <= 69) {
          return String.fromCharCode(("0".charCodeAt(0)) + (i - 6) / 7);
        }
  
        return String.fromCharCode(("a".charCodeAt(0)) + ((i - 76) / 7));
      }
    }
  
    return "e";
  };

function makeV2Address (key: string, prefix: string) {
    const chars = ["", "", "", "", "", "", "", "", ""];
    let hash = sha256(sha256(key));
  
    for (let i = 0; i <= 8; i++) {
      chars[i] = hash.substring(0, 2);
      hash = sha256(sha256(hash));
    }
  
    for (let i = 0; i <= 8;) {
      const index = parseInt(hash.substring(2 * i, 2 + (2 * i)), 16) % 9;
  
      if (chars[index] === "") {
        hash = sha256(hash);
      } else {
        prefix += hexToBase36(parseInt(chars[index], 16));
        chars[index] = "";
        i++;
      }
    }
  
    return prefix;
};

async function updateCurrencies(currencies: Record<string, Currency>) {
  for (const [currency, info] of Object.entries(currencies)) {
    try {
      const currencyMotd = await axios.get(info.syncNode + "/motd");
      const currencyData = currencyMotd.data;
      info.constants = currencyData.constants;
      info.currency = currencyData.currency;
      if (info.currency) {
        info.address = makeV2Address(info.privateKey, info.currency.address_prefix);
      }
    } catch (error) {
      console.error("Failed to load", currency, error);
    }
  }
}

async function startWebsocket(currency: Currency, currencies: Record<string, Currency>) {
  try {
    const wsResponse = await axios.post(currency.syncNode + "/ws/start");
    const wsData = wsResponse.data;
    const ws = new WebSocket(wsData.url);
    currency.ws = ws;
    let messageId = 1;
    currency.send = function (to, amount, metadata) {
      const makeTransaction = {"id": messageId, "type": "make_transaction", "to": to, "amount": amount, "metadata": metadata};
      ws.send(JSON.stringify(makeTransaction));
      messageId++;
    }
    ws.on('open', function open() {
      const login = {"id": messageId, "type": "login", "privatekey": currency.privateKey};
      ws.send(JSON.stringify(login));
      messageId++;
      const subscribeValidators = {"id": messageId, "type": "subscribe", "event": "ownTransactions"};
      ws.send(JSON.stringify(subscribeValidators));
      messageId++;
      /*const subscribeBlocks = {"id": messageId, "type": "subscribe", "event": "blocks"};
      ws.send(JSON.stringify(subscribeBlocks))
      messageId++;*/
    });
    ws.on('message', function incoming(data: string) {
      const messageData = JSON.parse(data);
      if (messageData.type === "hello") {
        console.log("Received hello block on", currency.currency?.currency_name, messageData.last_block.hash);
      } else if (messageData.type === "event" && messageData.event === "block") {
        console.log("Received new block on", currency.currency?.currency_name, messageData.block.hash);
      } else if (messageData.type === "event" && messageData.event === "transaction" && messageData.transaction) {
        const metadata: string[] = (messageData.transaction.metadata ?? "").split(";");
        if (messageData.transaction.type === "transfer" && messageData.transaction.sent_name === currency.name) {
          if (messageData.transaction.sent_metaname.length == 10) {

            let sendTo = "";
            let targetCurrency: Currency | undefined = undefined;
            let exchangeRate: Big | undefined = undefined;
            let found = 0;
            for (const [targetCurrencyName, currencyExchangeRate] of Object.entries(currency.exchange)) {
              if (currencies[targetCurrencyName].currency?.address_prefix === messageData.transaction.sent_metaname.substring(0,1)) {
                found++;
                sendTo = messageData.transaction.sent_metaname;
                targetCurrency = currencies[targetCurrencyName];
                exchangeRate = currencyExchangeRate;
              }
            }
            if (found == 1 && targetCurrency && exchangeRate) {
              const inputAmount = new Big(messageData.transaction.value);
              const outputAmount = inputAmount.times(exchangeRate).toFixed(targetCurrency.decimals);
              if (targetCurrency.send) {
                targetCurrency.send(sendTo, outputAmount, "");
                console.log("Exchanged", inputAmount.toString(), currency.currency?.currency_symbol, "for", outputAmount, targetCurrency.currency?.currency_symbol, "to", sendTo);
              } else {
                console.log("Failed to exchange", inputAmount.toString(), currency.currency?.currency_symbol, "for", outputAmount, targetCurrency.currency?.currency_symbol, "to", sendTo);
              }
            } else {
              for (let i = 0; i < metadata.length; i++) {
                const meta = metadata[i];
                if (meta.substring(0, 7) === "return=") {
                  const returnTo = meta.substring(7);
                  if (currency.send) {
                    currency.send(returnTo, messageData.transaction.value, "message=That exchange is not available");
                    console.log("Returned", messageData.transaction.value, currency.currency?.currency_symbol, "to", returnTo);
                  } else {
                    console.log("Failed to return", messageData.transaction.value, currency.currency?.currency_symbol, "to", returnTo);
                  }
                  break;
                }
              }
            }
          } else {
            for (let i = 0; i < metadata.length; i++) {
              const meta = metadata[i];
              if (meta.substring(0, 7) === "return=") {
                const returnTo = meta.substring(7);
                if (currency.send) {
                  currency.send(returnTo, messageData.transaction.value, "message=That exchange is not available");
                  console.log("Returned", messageData.transaction.value, currency.currency?.currency_symbol, "to", returnTo);
                } else {
                  console.log("Failed to return", messageData.transaction.value, currency.currency?.currency_symbol, "to", returnTo);
                }
                break;
              }
            }
          }
        }
        //Transaction
        //console.log(messageData);
      } else if (messageData.ok && messageData.hasOwnProperty('isGuest') && messageData.address) {
        console.log("Authed as", messageData.address.address);
      }
    });
  } catch (error) {
    console.error("Failed to connect ws to ", currency.currency?.currency_name, error);
  }
}

async function start() {
  await updateCurrencies(currencies);
  for (const [currency, info] of Object.entries(currencies)) {
    await startWebsocket(info, currencies);
  }
}

start();