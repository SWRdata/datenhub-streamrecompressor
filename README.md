# HTTP Stream Recompressor

The HTTP Stream Recompressor is a Node.js package designed to dynamically recompress HTTP streams based on request and response headers. It supports various encoding formats such as Brotli (`br`), Gzip (`gzip`), and Deflate (`deflate`), and provides a flexible way to handle raw data without compression (`raw`).

## Features

- **Dynamic Compression and Decompression**: Automatically decompresses and compresses streams according to the `Accept-Encoding` request header and the `Content-Encoding` response header.
- **Support for Multiple Encodings**: Includes support for `br`, `gzip`, `deflate`, and `raw` encoding types.
- **Queue Management**: Uses `P-Queue` to manage compression tasks with controlled concurrency, ensuring efficient processing of multiple streams.
- **Fast Compression Option**: Allows for faster compression at the expense of compression ratio, useful for real-time data streaming.

## Installation

To install the HTTP Stream Recompressor package, use the following command:

```bash
npm install http-stream-recompressor
```

Or if you prefer using Yarn:

```bash
yarn add http-stream-recompressor
```

## Usage

Here's a basic example of how to use the HTTP Stream Recompressor in your Node.js application:

```javascript
import express from 'express';
import { httpStreamRecompress } from 'http-stream-recompressor';

const app = express();

app.get('/data', (req, res) => {
    const headersRequest = req.headers;
    const headersResponse = {};
    const streamIn = getYourDataStream(); // Replace this with your data stream source
    const fastCompression = true; // Set to true for fast compression, false for higher compression ratio

    httpStreamRecompress(headersRequest, headersResponse, streamIn, res, fastCompression);
});

app.listen(3000, () => console.log('Server running on port 3000'));
```

## API Reference

### httpStreamRecompre``ss(headersRequest, headersResponse, streamIn, response, fastCompression)

Compresses or decompresses an HTTP stream.

**Parameters:**

- `headersRequest`: An object containing the request headers.
- `headersResponse`: An object containing the response headers.
- `streamIn`: The input stream to recompress.
- `response`: The Express response object to which the resulting data is streamed.
- `fastCompression`: Boolean indicating whether fast compression should be used.

## Contributing

Contributions to the HTTP Stream Recompressor are welcome. Please feel free to submit pull requests or create issues for bugs and feature requests.

## License

This project is licensed under the [MIT License](LICENSE).
