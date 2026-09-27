export function errorHandler(err, req, res, _next) {
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'request_too_large' });
  console.error('HTTP request failed', { method: req.method });
  res.status(500).json({ error: 'internal_error' });
}
