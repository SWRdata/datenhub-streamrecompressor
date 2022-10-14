'user strict'



import zlib from 'zlib';
import through from 'through2';
import PQueue from 'p-queue';



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



const queue = new PQueue({
	concurrency: 1,
	timeout: 3*60*1000,
});
export {
	httpStreamRecompress,
}



function httpStreamRecompress(headersRequest = {}, headersResponse = {}, streamIn, response, fastCompression = false) {
	queue.add(() => new Promise(resolve => {
		// detect encoding:
		let encodingIn = detectEncoding(headersResponse['content-encoding']);
		let encodingOut;

		let type = ('' + headersResponse['content-type']).replace(/\/.*/, '').toLowerCase();

		// do not recompress images, videos, ...
		switch (type) {
			case 'audio':
			case 'image':
			case 'video':
				encodingOut = ENCODINGS.raw();
			break;
			default:
				let ignoreBrotli = fastCompression && (encodingIn.name === 'gzip');
				encodingOut = detectEncoding(headersRequest['accept-encoding'], ignoreBrotli);
		}

		headersResponse['vary'] = 'accept-encoding';

		encodingOut.setEncoding(headersResponse);

		let stream = streamIn;

		let transform1 = encodingIn.decompressStream();
		if (transform1) stream = stream.pipe(transform1)


		stream.pipe(BufferStream(16*MB,
			async (buffer) => {
				buffer = await encodingOut.compressBuffer(buffer, fastCompression);

				delete headersResponse['transfer-encoding'];
				headersResponse['content-length'] = buffer.length;

				response
					.status(200)
					.set(headersResponse)
					.end(buffer);
				
				resolve();
			},
			(stream) => {
				headersResponse['transfer-encoding'] = 'chunked';
				delete headersResponse['content-length'];

				response
					.status(200)
					.set(headersResponse)

				let transform2 = encodingOut.compressStream(fastCompression);
				if (transform2) stream = stream.pipe(transform2);

				stream.pipe(response).on('finish', () => resolve());
			}
		));
	}))
}



function detectEncoding(text, ignoreBrotli) {
	text = ('' + text).toLowerCase();

	if (!ignoreBrotli && text.includes('br')) return ENCODINGS.br();
	if (text.includes('gzip')) return ENCODINGS.gzip();
	if (text.includes('deflate')) return ENCODINGS.deflate();
	return ENCODINGS.raw();
}



function BufferStream(maxSize, handleBuffer, handleStream) {
	let buffers = [], size = 0, bufferMode = true;
	let stream = through(
		function (chunk, enc, cb) {
			if (bufferMode) {
				buffers.push(chunk);
				size += chunk.length;
				if (size >= maxSize) {
					bufferMode = false;
					handleStream(stream);
					for (let buffer of buffers) this.push(buffer);
				}
				return cb();
			} else {
				cb(null, chunk);
			}
		},
		(cb) => {
			if (bufferMode) handleBuffer(Buffer.concat(buffers));
			cb()
		}
	)
	return stream;
}
