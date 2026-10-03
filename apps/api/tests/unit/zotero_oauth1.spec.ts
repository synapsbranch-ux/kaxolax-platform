import { test } from '@japa/runner'
import {
  authorizationHeader,
  baseStringUri,
  hmacSha1Signature,
  percentEncode,
  signatureBaseString,
} from '#services/zotero/oauth1'

/** Paramètres de l'en-tête `Authorization: OAuth …`, décodés. */
function headerParameters(header: string): Record<string, string> {
  assertPrefix(header)
  return Object.fromEntries(
    [...header.matchAll(/([a-z_]+)="([^"]*)"/g)].map((match) => [
      match[1] ?? '',
      decodeURIComponent(match[2] ?? ''),
    ]),
  )
}

function assertPrefix(header: string) {
  if (!header.startsWith('OAuth ')) throw new Error(`not an OAuth header: ${header}`)
}

test.group('zotero: OAuth 1.0a signature', () => {
  test('percent-encodes like RFC 5849', ({ assert }) => {
    assert.equal(percentEncode("a b!*'()~-._"), 'a%20b%21%2A%27%28%29~-._')
    assert.equal(percentEncode('é+&='), '%C3%A9%2B%26%3D')
  })

  test('normalizes the base string URI', ({ assert }) => {
    assert.equal(
      baseStringUri(new URL('HTTP://EXAMPLE.COM:80/r%20v/X?id=123')),
      'http://example.com/r%20v/X',
    )
    assert.equal(
      baseStringUri(new URL('https://www.example.net:8080/?q=1')),
      'https://www.example.net:8080/',
    )
  })

  test('builds the RFC 5849 section 3.4.1.1 base string', ({ assert }) => {
    const base = signatureBaseString(
      'post',
      new URL('http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b'),
      [
        ['oauth_consumer_key', '9djdj82h48djs9d2'],
        ['oauth_token', 'kkk9d7dh3k39sjv7'],
        ['oauth_signature_method', 'HMAC-SHA1'],
        ['oauth_timestamp', '137131201'],
        ['oauth_nonce', '7d8f3e4a'],
        // Corps `c2&a3=2+q`.
        ['c2', ''],
        ['a3', '2 q'],
      ],
    )
    assert.equal(
      base,
      'POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7',
    )
  })

  test('signs the OAuth 1.0 appendix example (photos.example.net)', ({ assert }) => {
    const header = authorizationHeader(
      'GET',
      new URL('http://photos.example.net/photos?file=vacation.jpg&size=original'),
      {
        consumerKey: 'dpf43f3p2l4k3l03',
        consumerSecret: 'kd94hf93k423kf44',
        token: 'nnch734d00sl2jdk',
        tokenSecret: 'pfkkdhi9sl3r4s00',
      },
      { nonce: { nonce: 'kllo9940pd9333jh', timestamp: 1191242096 } },
    )
    const parameters = headerParameters(header)
    assert.equal(parameters.oauth_signature, 'tR3+Ty81lMeYAr/Fid0kMTYa/WM=')
    assert.equal(parameters.oauth_token, 'nnch734d00sl2jdk')
    assert.equal(parameters.oauth_version, '1.0')
    // Les paramètres de la requête ne vont pas dans l'en-tête.
    assert.notProperty(parameters, 'file')
  })

  test('signs the Twitter documentation example (form body)', ({ assert }) => {
    const header = authorizationHeader(
      'POST',
      new URL('https://api.twitter.com/1.1/statuses/update.json?include_entities=true'),
      {
        consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
        consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
        token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
        tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
      },
      {
        body: [['status', 'Hello Ladies + Gentlemen, a signed OAuth request!']],
        nonce: { nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: 1318622958 },
      },
    )
    assert.equal(headerParameters(header).oauth_signature, 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=')
  })

  test('uses an empty token secret before the access token exists', ({ assert }) => {
    const signature = hmacSha1Signature('GET&x&y', 'secret')
    assert.equal(signature, hmacSha1Signature('GET&x&y', 'secret', ''))
    assert.notEqual(signature, hmacSha1Signature('GET&x&y', 'secret', 'token-secret'))
  })

  test('adds oauth_callback and oauth_verifier to the signed parameters', ({ assert }) => {
    const url = new URL('https://www.zotero.org/oauth/request')
    const credentials = { consumerKey: 'key', consumerSecret: 'secret' }
    const nonce = { nonce: 'n', timestamp: 1 }
    const withCallback = headerParameters(
      authorizationHeader('POST', url, credentials, {
        extra: { oauth_callback: 'https://app.example/cb?state=a b' },
        nonce,
      }),
    )
    assert.equal(withCallback.oauth_callback, 'https://app.example/cb?state=a b')
    const other = headerParameters(
      authorizationHeader('POST', url, credentials, {
        extra: { oauth_callback: 'https://app.example/cb?state=other' },
        nonce,
      }),
    )
    assert.notEqual(withCallback.oauth_signature, other.oauth_signature)
  })
})
