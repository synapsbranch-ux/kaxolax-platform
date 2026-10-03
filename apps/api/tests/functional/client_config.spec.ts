import { clientConfigSchema } from '@kaxolax/contracts'
import { test } from '@japa/runner'
import { storageOrigin } from '#controllers/client_config_controller'
import realtimeConfig from '#config/realtime'
import storageConfig from '#config/storage'

test.group('Client config', () => {
  test('gives the browser origins without authentication', async ({ client, assert }) => {
    const response = await client.get('/api/v1/client-config')
    response.assertStatus(200)
    assert.equal(response.header('cache-control'), 'no-store')
    const body = clientConfigSchema.parse(response.body())
    assert.equal(body.realtimeUrl, realtimeConfig.publicUrl)
    assert.equal(body.storageUrl, storageConfig.publicEndpoint ?? storageConfig.endpoint ?? null)
  })

  test('derives the storage origin like the presigned URLs', ({ assert }) => {
    assert.equal(
      storageOrigin({
        publicEndpoint: 'https://storage.kaxolax.com',
        endpoint: 'http://seaweedfs:8333',
        region: 'auto',
      }),
      'https://storage.kaxolax.com',
    )
    assert.equal(
      storageOrigin({ endpoint: 'https://account.eu.r2.cloudflarestorage.com', region: 'auto' }),
      'https://account.eu.r2.cloudflarestorage.com',
    )
    assert.equal(storageOrigin({ region: 'eu-west-3' }), 'https://s3.eu-west-3.amazonaws.com')
    assert.isNull(storageOrigin({ region: 'auto' }))
  })
})
