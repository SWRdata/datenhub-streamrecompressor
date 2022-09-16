'user strict'

const zlib = require('zlib');

module.exports = {
	httpStreamRecompress,
}

const MB = 1024*1024;
const ENCODINGS = {
	br: () => {
		function getOptions(fast, size) {
			let params = { [zlib.constants.BROTLI_PARAM_QUALITY]: fast ? 3 : 11 };
			if (size) params[zlib.constants.BROTLI_PARAM_SIZE_HINT] = size;
			return { params };
		}
		return {
			name: 'br',
			compressStream: (fast, size) => zlib.createBrotliCompress(getOptions(fast, size)),
			decompressStream: () => zlib.createBrotliDecompress(),
			compressBuffer: (buffer, fast) => new Promise(res => zlib.brotliCompress(buffer, getOptions(fast, buffer.length), (e,b) => res(b))),
			decompressBuffer: (buffer) => new Promise(res => zlib.brotliDecompress(buffer, (e,b) => res(b))),
			setEncoding: (headers) => headers['content-encoding'] = 'br',
		}
	},
	gzip: () => {
		function getOptions(fast) {
			return { level: fast ? 3 : 9 }
		}
		return {
			name: 'gzip',
			compressStream: (fast) => zlib.createGzip(getOptions(fast)),
			decompressStream: () => zlib.createGunzip(),
			compressBuffer: (buffer, fast) => new Promise(res => zlib.gzip(buffer, getOptions(fast), (e,b) => res(b))),
			decompressBuffer: (buffer) => new Promise(res => zlib.gunzip(buffer, (e,b) => res(b))),
			setEncoding: (headers) => headers['content-encoding'] = 'gzip',
		}
	},
	deflate: () => {
		function getOptions(fast) {
			return { level: fast ? 3 : 9 }
		}
		return {
			name: 'deflate',
			compressStream: (fast) => zlib.createDeflate(getOptions(fast)),
			decompressStream: () => zlib.createInflate(),
			compressBuffer: (buffer, fast) => new Promise(res => zlib.deflate(buffer, getOptions(fast), (e,b) => res(b))),
			decompressBuffer: (buffer) => new Promise(res => zlib.inflate(buffer, (e,b) => res(b))),
			setEncoding: (headers) => headers['content-encoding'] = 'deflate',
		}
	},
	raw: () => ({
		name: 'raw',
		compressStream: () => false,
		decompressStream: () => false,
		compressBuffer: buffer => buffer,
		decompressBuffer: buffer => buffer,
		setEncoding: (headers) => { delete headers['content-encoding'] },
	}),
}

function httpStreamRecompress(headersRequest = {}, headersResponse = {}, streamIn, response, fastCompression = false) {
	
	let type = ('' + headersResponse['content-type']).replace(/\/.*/, '').toLowerCase();

	// do not recompress images, videos, ...
	switch (type) {
		case 'image': return passThrough();
		case 'video': return passThrough();
	}
	headersResponse['vary'] = 'accept-encoding';

	let size = headersResponse['content-length'];
	if (size === undefined) fastCompression = true; // might be big

	size = parseInt(size, 10) || false;

	// do not recompress, when size is to small:
	if (size && (size < 100)) return passThrough();

	// use fast compression, when to big
	if (size > 16 * MB) fastCompression = true;

	// detect encoding:
	let encodingIn = detectEncoding(headersResponse['content-encoding']);
	let ignoreBrotli = fastCompression && (encodingIn.name === 'gzip');
	let encodingOut = detectEncoding(headersRequest['accept-encoding'], ignoreBrotli);

	// do nothing, when encodings are equal:
	if (encodingIn.name === encodingOut.name) return passThrough();

	if (size && (size < 16*MB)) {
		// do recompression with buffers
		return recompressViaBuffer();
	} else {
		// do recompression with streams
		return recompressViaStream();
	}



	function passThrough() {
		prepareStreaming();
		
		streamIn.pipe(response);
	}

	function recompressViaStream() {
		delete headersResponse['content-length'];
		encodingOut.setEncoding(headersResponse);

		prepareStreaming()

		let stream = streamIn;

		let transform1 = encodingIn.decompressStream();
		if (transform1) stream = stream.pipe(transform1)

		let transform2 = encodingOut.compressStream(fastCompression, size);
		if (transform2) stream = stream.pipe(transform2)
		
		stream.pipe(response);
	}

	async function recompressViaBuffer() {
		let buffer = [];

		streamIn.on('data', chunk => buffer.push(chunk));
		await new Promise(resolve => streamIn.on('end', resolve))

		buffer = Buffer.concat(buffer);
		buffer = await encodingIn.decompressBuffer(buffer);
		buffer = await encodingOut.compressBuffer(buffer, fastCompression);

		headersResponse['content-length'] = buffer.length;
		encodingOut.setEncoding(headersResponse);

		response
			.status(200)
			.set(headersResponse)
			.end(buffer);
	}

	function prepareStreaming() {
		if (size && (size < 4*MB)) {
			delete headersResponse['transfer-encoding'];
		} else {
			headersResponse['transfer-encoding'] = 'chunked';
			delete headersResponse['content-length'];
		}
		
		response
			.status(200)
			.set(headersResponse);
	}

	function detectEncoding(text, ignoreBrotli) {
		text = ('' + text).toLowerCase();

		if (!ignoreBrotli && text.includes('br')) return ENCODINGS.br();
		if (text.includes('gzip')) return ENCODINGS.gzip();
		if (text.includes('deflate')) return ENCODINGS.deflate();
		return ENCODINGS.raw();
	}
}
