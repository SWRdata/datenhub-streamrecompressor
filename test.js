'use strict'



import zlib from 'zlib';
import miss from 'mississippi2';
import { httpStreamRecompress } from './index.js';





async function start() {
	const KB = 1024;
	const MB = 1024 * 1024;
	const compressions = ['raw', 'gzip', 'br'];
	const sizes = [50, 50 * KB, 2 * MB, 9 * MB, 33 * MB];

	const testBuffer = new TestBuffer();



	// generate preparations
	const preparations = [];
	for (let compression of compressions) for (let size of sizes) preparations.push({ size, compression });

	// run preparations
	for (let [index, { size, compression }] of preparations.entries()) {
		process.stderr.write(`\rprepare test buffers: ${(100 * (index + 1) / preparations.length).toFixed(0)}%`)
		testBuffer.get(compression, size);
	}
	console.log('')



	// generate tests
	const tests = [];
	for (let contentType of [false, 'image/png', 'application/json']) {
		for (let acceptEncoding of ['', 'gzip, deflate, br', 'gzip, deflate']) {
			for (let compression of compressions) {
				for (let size of sizes) {
					for (let useContentLength of [true, false]) {
						for (let fast of [true, false]) {
							tests.push({ contentType, acceptEncoding, compression, size, useContentLength, fast });
						}
					}
				}
			}
		}
	}

	// run tests
	for (let [index, test] of tests.entries()) {
		process.stderr.write(`\rrun tests: ${(100 * (index + 1) / tests.length).toFixed(0)}%`)

		const { contentType, acceptEncoding, compression, size, useContentLength, fast } = test;

		const { bufferIn, bufferRawIn } = testBuffer.get(compression, size);

		let headersRequestIn = { 'accept-encoding': acceptEncoding };

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

	console.log('\nFinished')
}

class TestBuffer {
	#data;
	#comCache;
	#rawCache;

	constructor() {
		this.#data = Buffer.from(Uint8Array.from({ length: 256 }, () => Math.floor(Math.random() * 256)));
		this.#rawCache = new Map();
		this.#comCache = new Map();
	}

	#getRaw(size) {
		if (this.#rawCache.has(size)) return this.#rawCache.get(size);

		const bufferRawIn = Buffer.allocUnsafe(size);
		for (let i = 0; i < size; i += this.#data.length) this.#data.copy(bufferRawIn, i);

		this.#rawCache.set(size, bufferRawIn);
		return bufferRawIn;
	}

	get(compression, size) {
		if (this.#comCache.has(compression + size)) return this.#comCache.get(compression + size);

		const bufferRawIn = this.#getRaw(size);

		let bufferIn;
		switch (compression) {
			case 'raw': bufferIn = bufferRawIn.slice(); break;
			case 'gzip': bufferIn = zlib.gzipSync(bufferRawIn); break;
			case 'br': bufferIn = zlib.brotliCompressSync(bufferRawIn); break;
			default: throw Error();
		}

		const result = { bufferIn, bufferRawIn };
		this.#comCache.set(compression + size, result);
		return result;
	}
}

start()

