'use strict'

const zlib = require('zlib');
const miss = require('mississippi2');
const { httpStreamRecompress } = require('./index.js');
const { writeFileSync } = require('fs');

const KB = 1024;
const MB = 1024 * 1024;

start()

async function start() {
	const tests = [];
	for (let contentType of [false, 'image/png', 'application/json']) {
		for (let acceptEncoding of ['', 'gzip, deflate, br', 'gzip, deflate']) {
			for (let compression of ['raw', 'gzip', 'br']) {
				for (let size of [50, 50 * KB, 2 * MB, 9 * MB, 33 * MB]) {
					for (let useContentLength of [true, false]) {
						for (let fast of [true, false]) {
							tests.push({ contentType, acceptEncoding, compression, size, useContentLength, fast });
						}
					}
				}
			}
		}
	}

	//let data = Uint8Array.from({ length: 256 }, () => Math.floor(Math.random() * 256));
	let data = Uint8Array.from({ length: 256 }, (v,i) => i);
	data = Buffer.from(data.buffer);
		
	for (let index = 0; index < tests.length; index++) {
		process.stderr.write(`\r   ${index + 1}/${tests.length}`)

		const test = tests[index];
		const { contentType, acceptEncoding, compression, size, useContentLength, fast } = test;
		//console.log(test);

		let bufferRawIn = Buffer.allocUnsafe(size);
		for (let i = 0; i < size; i += data.length) data.copy(bufferRawIn, i);

		let bufferIn;
		switch (compression) {
			case 'raw': bufferIn = bufferRawIn; break;
			case 'gzip': bufferIn = zlib.gzipSync(bufferRawIn); break;
			case 'br': bufferIn = zlib.brotliCompressSync(bufferRawIn); break;
			default: throw Error();
		}

		let headersRequestIn = {'accept-encoding': acceptEncoding};

		let headersResponseIn = {};
		if (compression !== 'raw') headersResponseIn['content-encoding'] = compression;
		if (contentType) headersResponseIn['content-type'] = contentType;
		if (useContentLength) headersResponseIn['content-length'] = bufferIn.length;

		let streamIn = miss.fromValue(bufferIn);
		let responseHeaders, statusCode;
		let bufferOut = await new Promise(resolve => {
			let buffers = [];
			let streamOut = miss.to(
				(chunk, enc, cb) => { buffers.push(chunk); cb() },
				(cb) => { resolve(Buffer.concat(buffers)); cb() }
			);
			streamOut.status = code => {
				statusCode = code;
				if (code !== 200) throw Error();
				return streamOut;
			}
			streamOut.set = h => {
				responseHeaders = h;
				return streamOut;
			};
			httpStreamRecompress(headersRequestIn, Object.assign({}, headersResponseIn), streamIn, streamOut, fast)
		})

		let bufferRawOut;
		let contentEncoding = responseHeaders['content-encoding']
		
		//console.log({ headersResponseIn, responseHeaders }, compression, [bufferRawIn.length, bufferIn.length, bufferOut.length]);
		
		switch (contentEncoding) {
			case undefined: bufferRawOut = bufferOut; break;
			case 'br': bufferRawOut = zlib.brotliDecompressSync(bufferOut); break;
			case 'gzip': bufferRawOut = zlib.gunzipSync(bufferOut); break;
			default: throw Error(contentEncoding);
		}

		if (!bufferRawIn.equals(bufferRawOut)) throw Error('not the same buffers');
		if (responseHeaders['content-length'] && (responseHeaders['content-length'] !== bufferOut.length)) throw Error();
		if (responseHeaders['vary'] !== 'accept-encoding') throw Error();
		if (bufferOut.length > 32 * MB) {
			if (responseHeaders['transfer-encoding'] !== 'chunked') throw Error();
			if (responseHeaders['content-length']) throw Error();
		}
	}


}


