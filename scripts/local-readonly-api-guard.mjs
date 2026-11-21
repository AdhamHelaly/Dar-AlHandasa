import { createServer, request } from 'node:http';

const HOST = '127.0.0.1';
const PORT = 3000;
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 3103;
const FRONTEND_ORIGIN = 'http://127.0.0.1:4200';
const LOGIN_PATH = '/api/admin/login';
const LOGIN_BODY_MAX_BYTES = 16 * 1024;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 12;
const LOGIN_REQUEST_TIMEOUT_MS = 10 * 1000;
const loginAttempts = new Map();

function json(res, status, body) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function allowLoginAttempt(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  for (const [key, attempt] of loginAttempts) {
    if (now - attempt.startedAt >= LOGIN_WINDOW_MS) loginAttempts.delete(key);
  }
  let attempt = loginAttempts.get(ip);
  if (!attempt || now - attempt.startedAt >= LOGIN_WINDOW_MS) {
    attempt = { startedAt: now, count: 0 };
    loginAttempts.set(ip, attempt);
  }
  if (attempt.count >= LOGIN_MAX_ATTEMPTS) return false;
  attempt.count += 1;
  return true;
}

function readLoginBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let completed = false;
    const finish = result => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      req.pause();
      finish({ timedOut: true, tooLarge: false, body: Buffer.alloc(0) });
    }, LOGIN_REQUEST_TIMEOUT_MS);
    timer.unref();

    req.on('data', chunk => {
      size += chunk.length;
      if (size > LOGIN_BODY_MAX_BYTES) {
        chunks.length = 0;
        req.pause();
        finish({ timedOut: false, tooLarge: true, body: Buffer.alloc(0) });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ timedOut: false, tooLarge: false, body: Buffer.concat(chunks) }));
    req.on('error', error => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function proxyGet(req, res) {
  const upstream = request({
    hostname: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    path: req.url,
    method: 'GET',
    headers: {
      accept: req.headers.accept || '*/*',
      authorization: req.headers.authorization || '',
      origin: req.headers.origin || ''
    }
  }, reply => {
    res.writeHead(reply.statusCode || 502, reply.headers);
    reply.pipe(res);
  });
  upstream.on('error', () => json(res, 502, { error: 'read_only_api_unavailable' }));
  req.pipe(upstream);
}

function proxyAdminLogin(req, res, body) {
  const headers = {
    'content-type': req.headers['content-type'] || 'application/json',
    'content-length': String(body.length),
    origin: req.headers.origin || ''
  };
  if (req.headers.accept) headers.accept = req.headers.accept;

  const upstream = request({
    hostname: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    path: LOGIN_PATH,
    method: 'POST',
    headers
  }, reply => {
    res.writeHead(reply.statusCode || 502, reply.headers);
    reply.pipe(res);
  });
  upstream.on('error', () => json(res, 502, { error: 'read_only_api_unavailable' }));
  upstream.end(body);
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const exactLoginPath = req.url === LOGIN_PATH;
  if (origin && origin !== FRONTEND_ORIGIN) {
    res.writeHead(403);
    return res.end();
  }

  res.setHeader('Access-Control-Allow-Origin', FRONTEND_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', exactLoginPath ? 'GET, POST, OPTIONS' : 'GET, OPTIONS');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && req.url?.startsWith('/api/')) return proxyGet(req, res);

  if (req.method === 'POST' && exactLoginPath) {
    if (!allowLoginAttempt(req)) return json(res, 429, { error: 'too_many_requests' });
    const contentLength = req.headers['content-length'];
    if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > LOGIN_BODY_MAX_BYTES)) {
      res.once('finish', () => req.destroy());
      return json(res, 413, { error: 'request_too_large' });
    }
    try {
      const payload = await readLoginBody(req);
      if (payload.tooLarge) {
        res.once('finish', () => req.destroy());
        return json(res, 413, { error: 'request_too_large' });
      }
      if (payload.timedOut) {
        res.once('finish', () => req.destroy());
        return json(res, 408, { error: 'request_timeout' });
      }
      return proxyAdminLogin(req, res, payload.body);
    } catch (error) {
      return json(res, 400, { error: 'invalid_request' });
    }
  }

  return json(res, 403, { error: 'read_only_review_guard' });
});

server.listen(PORT, HOST, () => {
  console.log(`Read-only compatibility guard listening at http://${HOST}:${PORT}; only GET plus POST ${LOGIN_PATH} are forwarded to ${UPSTREAM_HOST}:${UPSTREAM_PORT}.`);
});
