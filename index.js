'user strict';

// Importing required modules
import zlib from 'zlib'; // For compression and decompression
import through from 'through2'; // A thin wrapper around Node.js streams.Transform (for transforming streams)
import PQueue from 'p-queue'; // For managing a queue of promises with controlled concurrency

// Constants
const MB = 1024 * 1024; // Size of a Megabyte in bytes

// Encodings object to handle different types of compression and encoding
const ENCODINGS = {
	br: () => {
		// Function to get Brotli-specific options based on the desired compression speed and size hint
		function getOptions(fast, size) {
			let params = { [zlib.constants.BROTLI_PARAM_QUALITY]: fast ? 3 : 11 };
			if (size) params[zlib.constants.BROTLI_PARAM_SIZE_HINT] = size;
			return { params };
		}
		return {
			name: 'br',
			compressStream: (fast, size) => zlib.createBrotliCompress(getOptions(fast, size)),
			decompressStream: () => zlib.createBrotliDecompress(),
			compressBuffer: (buffer, fast) => new Promise(res => zlib.brotliCompress(buffer, getOptions(fast, buffer.length), (e, b) => res(b))),
			decompressBuffer: (buffer) => new Promise(res => zlib.brotliDecompress(buffer, (e, b) => res(b))),
			setEncoding: (headers) => headers['content-encoding'] = 'br',
		};
	},
	gzip: () => {
		// Function to get Gzip-specific options based on the desired compression speed
		function getOptions(fast) {
			return { level: fast ? 3 : 9 };
		}
		return {
			name: 'gzip',
			compressStream: (fast) => zlib.createGzip(getOptions(fast)),
			decompressStream: () => zlib.createGunzip(),
			compressBuffer: (buffer, fast) => new Promise(res => zlib.gzip(buffer, getOptions(fast), (e, b) => res(b))),
			decompressBuffer: (buffer) => new Promise(res => zlib.gunzip(buffer, (e, b) => res(b))),
			setEncoding: (headers) => headers['content-encoding'] = 'gzip',
		};
	},
	deflate: () => {
		// Function to get Deflate-specific options based on the desired compression speed
		function getOptions(fast) {
			return { level: fast ? 3 : 9 };
		}
		return {
			name: 'deflate',
			compressStream: (fast) => zlib.createDeflate(getOptions(fast)),
			decompressStream: () => zlib.createInflate(),
			compressBuffer: (buffer, fast) => new Promise(res => zlib.deflate(buffer, getOptions(fast), (e, b) => res(b))),
			decompressBuffer: (buffer) => new Promise(res => zlib.inflate(buffer, (e, b) => res(b))),
			setEncoding: (headers) => headers['content-encoding'] = 'deflate',
		};
	},
	raw: () => ({
		// Raw encoding (no compression)
		name: 'raw',
		compressStream: () => false,
		decompressStream: () => false,
		compressBuffer: buffer => buffer,
		decompressBuffer: buffer => buffer,
		setEncoding: (headers) => { delete headers['content-encoding']; },
	}),
};

// Initialize a new queue with a concurrency of 1 and a timeout of 3 minutes
const queue = new PQueue({
	concurrency: 1,
	timeout: 3 * 60 * 1000,
});

// Export the httpStreamRecompress function
export {
	httpStreamRecompress,
};

/**
 * Compresses or decompresses HTTP streams based on the request and response headers.
 * 
 * @param {Object} headersRequest The request headers
 * @param {Object} headersResponse The response headers
 * @param {Stream} streamIn The input stream
 * @param {Response} response The Express response object
 * @param {Boolean} fastCompression Indicates if fast compression should be used
 */
function httpStreamRecompress(headersRequest = {}, headersResponse = {}, streamIn, response, fastCompression = false) {
	queue.add(() => new Promise(resolve => {
		// Detect the input encoding based on the response's content-encoding header
		let encodingIn = detectEncoding(headersResponse['content-encoding']);
		let encodingOut;

		// Detect the type of content (e.g., image, video) to decide on compression
		let type = ('' + headersResponse['content-type']).replace(/\/.*/, '').toLowerCase();

		// Avoid compressing media types like audio, images, and videos
		switch (type) {
			case 'audio':
			case 'image':
			case 'video':
				encodingOut = ENCODINGS.raw();
				break;
			default:
				// Determine the desired output encoding based on the request's accept-encoding header
				let ignoreBrotli = fastCompression && (encodingIn.name === 'gzip');
				encodingOut = detectEncoding(headersRequest['accept-encoding'], ignoreBrotli);
		}

		// Adjust the Vary header to indicate the response varies based on accept-encoding
		headersResponse['vary'] = 'accept-encoding';

		// Set the content-encoding header based on the chosen output encoding
		encodingOut.setEncoding(headersResponse);

		let stream = streamIn;

		// If the input stream is compressed, decompress it first
		let transform1 = encodingIn.decompressStream();
		if (transform1) stream = stream.pipe(transform1);

		// Process the stream, either buffering it up to a limit or compressing and sending it directly
		stream.pipe(BufferStream(16 * MB,
			async (buffer) => {
				// Compress the entire buffered content if possible
				buffer = await encodingOut.compressBuffer(buffer, fastCompression);

				// Update the response headers based on the processed buffer
				delete headersResponse['transfer-encoding'];
				headersResponse['content-length'] = buffer.length;

				// Send the compressed buffer as the response
				response
					.status(200)
					.set(headersResponse)
					.end(buffer);

				resolve();
			},
			(stream) => {
				// If buffering exceeds the limit, switch to chunked transfer encoding
				headersResponse['transfer-encoding'] = 'chunked';
				delete headersResponse['content-length'];

				response
					.status(200)
					.set(headersResponse);

				// Compress the stream on-the-fly if needed
				let transform2 = encodingOut.compressStream(fastCompression);
				if (transform2) stream = stream.pipe(transform2);

				// Pipe the compressed stream directly to the response
				stream.pipe(response).on('finish', () => resolve());
			}
		));
	}))
}

/**
 * Detects the preferred encoding from a text string, optionally ignoring Brotli if specified.
 * 
 * @param {string} text The text containing the encoding information
 * @param {boolean} [ignoreBrotli=false] Whether to ignore Brotli encoding
 * @returns The detected encoding object
 */
function detectEncoding(text, ignoreBrotli = false) {
	text = ('' + text).toLowerCase();

	if (!ignoreBrotli && text.includes('br')) return ENCODINGS.br();
	if (text.includes('gzip')) return ENCODINGS.gzip();
	if (text.includes('deflate')) return ENCODINGS.deflate();
	return ENCODINGS.raw();
}

/**
 * Creates a transform stream that switches from buffering to streaming mode once a size limit is reached.
 * 
 * @param {number} maxSize The maximum buffer size before switching to streaming mode
 * @param {Function} handleBuffer Callback to handle the buffered content
 * @param {Function} handleStream Callback to handle the stream in streaming mode
 * @returns A transform stream
 */
function BufferStream(maxSize, handleBuffer, handleStream) {
	let buffers = [], size = 0, bufferMode = true;
	let stream = through(
		function (chunk, enc, cb) {
			if (bufferMode) {
				// While in buffer mode, accumulate chunks
				buffers.push(chunk);
				size += chunk.length;
				// Switch to stream mode if the size limit is reached
				if (size >= maxSize) {
					bufferMode = false;
					handleStream(stream);
					for (let buffer of buffers) this.push(buffer);
				}
				return cb();
			} else {
				// In stream mode, pass chunks through
				cb(null, chunk);
			}
		},
		(cb) => {
			// Once the stream ends, if still in buffer mode, process the accumulated buffer
			if (bufferMode) handleBuffer(Buffer.concat(buffers));
			cb();
		}
	);
	return stream;
}
