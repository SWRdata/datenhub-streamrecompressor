'user strict'

const zlib = require('zlib')
const pumpify = require('pumpify')
const { PassThrough } = require('stream');

module.exports = {
	StreamRecompressor,
}

function StreamRecompressor(headersRequest = {}, headersResponse = {}, fastCompression = false) {
	let type = (''+headersResponse['content-type']).replace(/\/.*/, '').toLowerCase();

	// do not recompress images, videos, ...
	switch (type) {
		case 'image': return doNothing();
		case 'video': return doNothing();
	}

	// do not recompress, when size is to small:
	let size = parseInt(headersResponse['content-length'], 10);
	if (size < 100) return doNothing();

	// do fast recompression, when size is to big:
	if (size > 32 * 1024 * 1024) fastCompression = true;

	let encodingIn = detectEncoding(headersResponse['content-encoding']);
	let encodingOut = detectEncoding(headersRequest['accept-encoding'], encodingIn.name);

	encodingOut.setEncoding(headersResponse);

	if (encodingIn.name === encodingOut.name) return doNothing();

	return mergeStream(
		encodingIn.decompress(),
		encodingOut.compress(size),
	)

	function doNothing() {
		return new PassThrough();
	}

	function detectEncoding(text, alreadyCompressed = false) {
		text = ('' + text).toLowerCase();

		if ((alreadyCompressed !== 'gzip') && text.includes('br')) return {
			name: 'br',
			compress: size => {
				let params = { [zlib.constants.BROTLI_PARAM_QUALITY]: fastCompression ? 5 : 11 };
				if (size) params[zlib.constants.BROTLI_PARAM_SIZE_HINT] = size;
				return zlib.createBrotliCompress({ params })
			},
			decompress: () => zlib.createBrotliDecompress(),
			setEncoding: headers => headers['content-encoding'] = 'br',
		}

		if (text.includes('gzip')) return {
			name: 'gzip',
			compress: () => zlib.createGzip({ level: fastCompression ? 5 : 9 }),
			decompress: () => zlib.createGunzip(),
			setEncoding: headers => headers['content-encoding'] = 'gzip',
		}

		if (text.includes('deflate')) return {
			name: 'deflate',
			compress: () => zlib.createDeflate({ level: fastCompression ? 5 : 9 }),
			decompress: () => zlib.createInflate(),
			setEncoding: headers => headers['content-encoding'] = 'deflate',
		}

		return {
			name: 'raw',
			compress: () => false,
			decompress: () => false,
			setEncoding: headers => { delete headers['content-encoding'] },
		}
	}

	function mergeStream(stream1, stream2) {
		if (!stream1) {
			if (!stream2) {
				return doNothing();
			} else {
				return stream2;
			}
		} else {
			if (!stream2) {
				return stream1;
			} else {
				return pumpify(stream1, stream2);
			}
		}
	}
}
