import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { test } from '@japa/runner'
import { s3ClientOptions } from '#services/object_storage'

// Valeurs fictives : la signature se calcule hors ligne, sans appel réseau.
const R2 = {
  region: 'auto',
  endpoint: 'https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com',
  forcePathStyle: true,
  accessKeyId: 'r2-test-access-key',
  secretAccessKey: 'r2-test-secret-key',
}

test.group('object storage (Cloudflare R2)', () => {
  test('builds a client without AWS-only options', ({ assert }) => {
    const options = s3ClientOptions(R2)
    assert.equal(options.region, 'auto')
    assert.equal(options.endpoint, R2.endpoint)
    assert.isTrue(options.forcePathStyle)
    // R2 ne connaît pas les checksums ajoutés par défaut à chaque requête par le SDK récent.
    assert.equal(options.requestChecksumCalculation, 'WHEN_REQUIRED')
    assert.equal(options.responseChecksumValidation, 'WHEN_REQUIRED')
    assert.deepEqual(options.credentials, {
      accessKeyId: R2.accessKeyId,
      secretAccessKey: R2.secretAccessKey,
    })
  })

  test('presigns path-style URLs for the auto region', async ({ assert }) => {
    const client = new S3Client(s3ClientOptions(R2))
    const download = new URL(
      await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: 'kaxolax-compile-outputs', Key: 'outputs/a/b/output.pdf' }),
        { expiresIn: 300 },
      ),
    )
    assert.equal(download.host, new URL(R2.endpoint).host)
    assert.equal(download.pathname, '/kaxolax-compile-outputs/outputs/a/b/output.pdf')
    assert.match(download.searchParams.get('X-Amz-Credential') ?? '', /\/auto\/s3\/aws4_request$/)
    // Aucun en-tête propre à AWS (ACL, SSE) dans une URL d'upload : R2 les refuserait.
    const upload = new URL(
      await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: 'kaxolax-project-files',
          Key: 'uploads/x',
          ContentLength: 3,
        }),
        { expiresIn: 300, signableHeaders: new Set(['content-length']) },
      ),
    )
    const signed = upload.searchParams.get('X-Amz-SignedHeaders') ?? ''
    assert.notMatch(signed, /x-amz-acl|x-amz-server-side-encryption|x-amz-storage-class/)
    client.destroy()
  })

  test('keeps the AWS defaults when no endpoint is set', ({ assert }) => {
    const options = s3ClientOptions({ region: 'eu-west-3', forcePathStyle: false })
    assert.isUndefined(options.endpoint)
    assert.isUndefined(options.credentials)
  })
})
