'use strict';

// Import necessary modules
import zlib from 'zlib'; // For compression and decompression functions
import miss from 'mississippi2'; // Utility library for working with streams in a more convenient way
import { httpStreamRecompress } from './index.js'; // Import the function to be tested

/**
 * Main function to start the test suite.
 */
async function start() {
	const KB = 1024; // Define a kilobyte
	const MB = 1024 * KB; // Define a megabyte
	// Define compression types to test
	const compressions = ['raw', 'gzip', 'br'];
	// Define different sizes of data to test with
	const sizes = [50, 50 * KB, 2 * MB, 9 * MB, 33 * MB];

	// Initialize TestBuffer to manage test buffers
	const testBuffer = new TestBuffer();

	// Prepare test scenarios with combinations of compression types and sizes
	const preparations = [];
	for (let compression of compressions) {
		for (let size of sizes) {
			preparations.push({ size, compression });
		}
	}

	// Pre-generate test buffers for each scenario to ensure readiness
	for (let [index, { size, compression }] of preparations.entries()) {
		process.stderr.write(`\rprepare test buffers: ${(100 * (index + 1) / preparations.length).toFixed(0)}%`);
		testBuffer.get(compression, size);
	}
	console.log('');

	// Generate test cases combining various factors like content type, accept encoding, etc.
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

	// Execute each test case
	for (let [index, test] of tests.entries()) {
		process.stderr.write(`\rrun tests: ${(100 * (index + 1) / tests.length).toFixed(0)}%`);

		const { contentType, acceptEncoding, compression, size, useContentLength, fast } = test;

		// Retrieve buffers for input and its raw counterpart
		const { bufferIn, bufferRawIn } = testBuffer.get(compression, size);

		// Set up request and response headers based on the test case
		let headersRequestIn = { 'accept-encoding': acceptEncoding };

		let headersResponseIn = {};
		if (compression !== 'raw') headersResponseIn['content-encoding'] = compression;
		if (contentType) headersResponseIn['content-type'] = contentType;
		if (useContentLength) headersResponseIn['content-length'] = bufferIn.length;

		// Create an input stream from the buffer
		let streamIn = miss.fromValue(bufferIn);
		let responseHeaders, statusCode;
		// Use a promise to handle the async nature of the stream processing
		let bufferOut = await new Promise(resolve => {
			let buffers = [];
			let streamOut = miss.to(
				(chunk, enc, cb) => { buffers.push(chunk); cb(); },
				(cb) => { resolve(Buffer.concat(buffers)); cb(); }
			);
			// Mock response object methods for status and setting headers
			streamOut.status = code => {
				statusCode = code;
				if (code !== 200) throw Error();
				return streamOut;
			};
			streamOut.set = h => {
				responseHeaders = h;
				return streamOut;
			};
			// Call the function under test with the prepared input and mock response
			httpStreamRecompress(headersRequestIn, Object.assign({}, headersResponseIn), streamIn, streamOut, fast);
		});

		// Determine the output buffer's raw form based on the content encoding
		let bufferRawOut;
		let contentEncoding = responseHeaders['content-encoding'];

		switch (contentEncoding) {
			case undefined: bufferRawOut = bufferOut; break;
			case 'br': bufferRawOut = zlib.brotliDecompressSync(bufferOut); break;
			case 'gzip': bufferRawOut = zlib.gunzipSync(bufferOut); break;
			default: throw Error(contentEncoding);
		}

		// Validate the integrity of the data after compression and decompression
		if (!bufferRawIn.equals(bufferRawOut)) throw Error('not the same buffers');
		if (responseHeaders['content-length'] && (responseHeaders['content-length'] !== bufferOut.length)) throw Error('Content length mismatch');
		if (responseHeaders['vary'] !== 'accept-encoding') throw Error('Missing or incorrect Vary header');
		// Additional checks for chunked transfer and content length headers based on buffer size
		if (bufferOut.length > 32 * MB) {
			if (responseHeaders['transfer-encoding'] !== 'chunked') throw Error('Expected chunked transfer encoding');
			if (responseHeaders['content-length']) throw Error('Unexpected content length header');
		}
	}

	console.log('\nFinished');
}

/**
 * TestBuffer class manages the creation and caching of buffers for different test scenarios.
 */
class TestBuffer {
	#data;
	#comCache; // Cache for compressed data
	#rawCache; // Cache for raw data

	constructor() {
		// Initialize random data for use in buffers
		this.#data = Buffer.from(Uint8Array.from({ length: 256 }, () => Math.floor(Math.random() * 256)));
		this.#rawCache = new Map();
		this.#comCache = new Map();
	}

	/**
	 * Retrieves a raw buffer of the specified size, caching it for future requests.
	 * @param {number} size The desired size of the buffer
	 * @returns {Buffer} The raw buffer
	 */
	#getRaw(size) {
		if (this.#rawCache.has(size)) return this.#rawCache.get(size);

		const bufferRawIn = Buffer.allocUnsafe(size);
		for (let i = 0; i < size; i += this.#data.length) this.#data.copy(bufferRawIn, i);

		this.#rawCache.set(size, bufferRawIn);
		return bufferRawIn;
	}

	/**
	 * Gets a buffer for a given compression type and size, either from cache or by generating and compressing a new one.
	 * @param {string} compression The compression type ('raw', 'gzip', 'br')
	 * @param {number} size The size of the buffer
	 * @returns {Object} An object containing the compressed buffer and its raw counterpart
	 */
	get(compression, size) {
		if (this.#comCache.has(compression + size)) return this.#comCache.get(compression + size);

		const bufferRawIn = this.#getRaw(size);

		let bufferIn;
		switch (compression) {
			case 'raw': bufferIn = bufferRawIn.slice(); break;
			case 'gzip': bufferIn = zlib.gzipSync(bufferRawIn); break;
			case 'br': bufferIn = zlib.brotliCompressSync(bufferRawIn); break;
			default: throw Error('Unsupported compression type');
		}

		const result = { bufferIn, bufferRawIn };
		this.#comCache.set(compression + size, result);
		return result;
	}
}

// Execute the start function to begin tests
start();
