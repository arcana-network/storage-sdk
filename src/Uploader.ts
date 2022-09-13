import {
  KeyGen,
  fromHexString,
  toHexString,
  makeTx,
  AESEncrypt,
  customError,
  isFileUploaded,
  getDKGNodes,
  getFile,
} from './Utils';
import { utils, BigNumber, Wallet, ethers } from 'ethers';
import axios, { AxiosInstance } from 'axios';
import { split } from 'shamir';
import { encrypt } from 'eciesjs';

import { randomBytes } from 'crypto-browserify';
import { id } from 'ethers/lib/utils';
import { Mutex } from 'async-mutex';

import {wrapInstance} from "./sentry";
import { requiresLocking } from './locking';
import { errorCodes } from './errors';

function generateCounterFromPartNumber (value: number) {
  if (value === 0) {
    return new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  }
  let counterValue = value / 16;
  const counter = new Uint8Array(16);
  for (let index = 15; index >= 0; --index) {
    counter[index] = counterValue % 256;
    counterValue = Math.floor(counterValue / 256);
  }
  return counter;
}

export class Uploader {
  private readonly provider: any;
  private readonly api: AxiosInstance;
  private readonly appAddress: string;
  private appId: number;
  private readonly lock: Mutex;

  constructor(appId: number, appAddress: string, provider: any, api: AxiosInstance, lock: Mutex, debug: boolean) {
    this.provider = provider;
    this.api = api;
    this.appId = appId;
    this.appAddress = appAddress;
    this.lock = lock;

    if (debug) {
      wrapInstance(this)
    }
  }

  onSuccess = () => {};

  onProgress = (bytesUploaded: number, bytesTotal: number): void => {};

  onError = (err) => {
    console.log('Error', err);
  };

  @requiresLocking
  async upload (fileRaw: File, params: UploadParams = {chunkSize: 10 * 2 ** 20, duplicate: false, publicFile: false}) {
    const file: File = fileRaw;
    const chunkSize = params.chunkSize? params.chunkSize : 10 * 2 ** 20
    const duplicate = params.duplicate ? params.duplicate: false
    if (!(file instanceof Blob)) {
      throw customError('TRANSACTION', 'File must be a Blob or a descendant of a Blob such as a File.')
    }

    const walletAddress = (await this.provider.send('eth_requestAccounts', []))[0];
    const hasher = new KeyGen(file, chunkSize);
    let key;
    const hash = await hasher.getHash();
    const signHash = await this.provider.send('personal_sign', [
      `Sign this to proceed with the encryption of file with hash ${hash}`,
      walletAddress,
    ]);
    let did = utils.id(hash + signHash);

    const prevFile = await getFile(did, this.provider);
    if (prevFile.owner) {
        if (prevFile.duplicate && duplicate === true) {
          did = ethers.utils.hexlify(ethers.utils.randomBytes(32))
        }
        if (prevFile.duplicate && duplicate === false) {
          const error =  "duplicate_can't_be_removed"
          throw customError(error, errorCodes[error])
        }
    }

    let host
    let JWTToken

    {
      key = await window.crypto.subtle.generateKey(
        {
          name: 'AES-CTR',
          length: 256,
        },
        true,
        ['encrypt', 'decrypt'],
      );
      const aesRaw = await crypto.subtle.exportKey('raw', key);
      const hexString = toHexString(aesRaw);
      const encryptedMetaData = await AESEncrypt(
        key,
        JSON.stringify({
          name: 'name' in file ? file.name : did,
          type: file.type,
          size: file.size,
          lastModified: 'lastModified' in file ? file.lastModified : new Date(),
          hash,
        }),
      );

      const node = (await this.api.get(`/get-node-address/?appid=${this.appId}`)).data;
      host = node.host;
      const ephemeralWallet = await Wallet.createRandom();
      const res = await makeTx(this.appAddress, this.api, this.provider, 'uploadInit', [
        did,
        BigNumber.from(file.size),
        utils.toUtf8Bytes(encryptedMetaData),
        node.address,
        ephemeralWallet.address,
        duplicate
      ]);
      JWTToken = res.token;
      const txHash = res.txHash;

      // Fetch DKG Node Details from dkg contract
      const nodes = await getDKGNodes(this.provider);
      // Doing shamir secrete sharing
      const parts = nodes.length;
      // At least 2/3rd nodes is required for share recovery
      const quorum = nodes.length - Math.floor(nodes.length / 3);
      const shares = split(randomBytes, parts, quorum, new Uint8Array(aesRaw));
      for (let i = 0; i < parts; i++) {
        const publicKey = nodes[i].pubKx._hex.replace('0x', '').padStart(64, '0') + nodes[i].pubKy._hex.replace('0x', '').padStart(64, '0');
        if (publicKey.length < 128) {
          console.log('public key is too short');
          continue;
        }
        const ciphertextRaw = encrypt(publicKey, shares[i + 1]);
        const ciphertext = ciphertextRaw.toString('hex');
        localStorage.setItem('pk', ephemeralWallet.privateKey);
        const url = 'https://' + nodes[i].declaredIp + '/rpc';
        await axios.post(url, {
          jsonrpc: '2.0',
          method: 'StoreKeyShare',
          id: 10,
          params: {
            tx_hash: txHash,
            encrypted_share: ciphertext,
            signature: await ephemeralWallet.signMessage(id(JSON.stringify({ tx_hash: txHash, encrypted_share: ciphertext }))),
          },
        });
      }
    }

    let completeResp

    try {
      const endpoint = new URL(host)
      endpoint.pathname = '/api/v2/file/' + did
      const headers = {
        Authorization: 'Bearer ' + JWTToken
      }

      // 1. Create a file
      await axios({
        method: 'POST',
        url: endpoint.href,
        headers
      })

      const parts = Math.ceil(file.size / chunkSize)
      let uploadedParts = 0
      let counter = 0
      endpoint.pathname = `/api/v2/file/${did}`
      while (uploadedParts < parts) {
        const slicedChunk = await file.slice(counter, Math.min(counter + chunkSize, file.size))
        const chunk = await slicedChunk.arrayBuffer()

        const cipherText = await window.crypto.subtle.encrypt(
          {
            counter: generateCounterFromPartNumber(uploadedParts),
            length: 64,
            name: 'AES-CTR',
          },
          key,
          chunk,
        );

        // 2. Upload parts
        await axios({
          method: 'PATCH',
          url: endpoint.href,
          params: {
            part: (uploadedParts + 1).toString()
          },
          headers: {
            ...headers,
            'Content-Type': 'application/octet-stream'
          },
          data: cipherText
        })

        counter += chunkSize
        uploadedParts++
        this.onProgress(counter, file.size)
      }

      endpoint.pathname = `/api/v2/file/${did}/complete`
      // 3. Complete the upload
      completeResp = (await axios({
        method: 'PATCH',
        url: endpoint.href,
        headers
      })).data
    } catch (e) {
      this.onError(e)
    }

    try {
      const tx = await this.provider.getTransaction(
        completeResp.hash.substring(0, 2) === '0x' ? completeResp.hash : '0x' + completeResp.hash,
      );
      await tx.wait();
      await this.onSuccess();
    } catch (e) {
      if (e.reason) {
        if (e.reason.includes('file_already_uploaded')) {
          throw customError('TRANSACTION', `File already exist. DID: ${did}`);
        } else {
          throw customError('TRANSACTION', e.reason);
        }
      } else {
        throw customError('', e.error);
      }
    }

    return did.replace("0x" , "");
  };
}
