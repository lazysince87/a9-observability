// Run in a separate terminal after the server is ready.
// Intentionally use Node's built-in HTTP module, without loading tracing.js,
// so only the server's spans are exported and request counts are predictable.
const http = require('node:http');
const assert = require('node:assert/strict');

const cases = [
  ['/todo', 200], ['/todo/1', 200], ['/todo', 200], ['/todo/2', 200],
  ['/todo', 200], ['/todo/3', 200], ['/todo/999', 404], ['/todo/invalid', 400],
];

function request(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${process.env.PORT || 3000}${path}`, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }).on('error', reject);
  });
}

(async () => {
  for (const [path, expectedStatus] of cases) {
    const result = await request(path);
    assert.equal(result.status, expectedStatus, path);
    if (path === '/todo') {
      assert.ok(Array.isArray(result.body));
      assert.ok(result.body.some(todo => todo.id === '1' && todo.title === 'Buy groceries'));
    }
    if (expectedStatus === 200 && path !== '/todo') {
      assert.equal(result.body.id, path.split('/').pop());
    }
    console.log(JSON.stringify({ path, ...result }));
  }
  console.log('Verified all 8 requests: 6 returned 200, 1 returned 404, 1 returned 400.');
})().catch(err => { console.error(err); process.exitCode = 1; });
