// Public, unauthenticated preflight only. No API key, account data or paid request is used.
const origin = 'https://appassets.androidplatform.net'
for (const endpoint of ['/models', '/anthropic/v1/messages', '/anthropic/v1/files', '/v1/tools/asr', '/v1/tools/tts']) {
  try {
    const headers = endpoint === '/models' ? 'authorization' : endpoint.startsWith('/anthropic/')
      ? 'content-type,x-api-key,anthropic-beta' : 'authorization,content-type'
    const response = await fetch(`https://api.deepseek.com${endpoint}`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': endpoint === '/models' ? 'GET' : 'POST', 'Access-Control-Request-Headers': headers },
      signal: AbortSignal.timeout(15_000),
    })
    const allowOrigin = response.headers.get('access-control-allow-origin')
    const allowMethods = response.headers.get('access-control-allow-methods')
    const allowHeaders = response.headers.get('access-control-allow-headers')
    const requested = headers.split(',')
    const permittedHeaders = (allowHeaders ?? '').toLowerCase().split(',').map((value) => value.trim())
    const allowed = response.ok && (allowOrigin === '*' || allowOrigin === origin)
      && (allowMethods ?? '').toUpperCase().includes(endpoint === '/models' ? 'GET' : 'POST')
      && (permittedHeaders.includes('*') || requested.every((value) => permittedHeaders.includes(value)))
    console.log(JSON.stringify({ endpoint, status: response.status, allowOrigin, allowMethods, allowHeaders, corsPreflight: allowed ? 'allowed' : 'NOT VERIFIED' }))
    if (!allowed) process.exitCode = 1
    await response.body?.cancel()
  } catch (error) {
    console.error(`${endpoint}: ${error.message}; direct API connectivity NOT VERIFIED`)
    process.exitCode = 1
  }
}
