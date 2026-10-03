import { describe, expect, it } from 'vitest'
import {
  USER_CHANNEL_RETRY_MAX_MS,
  USER_CHANNEL_RETRY_MIN_MS,
  userChannelRetryDelay,
} from './user-channel'

describe('user channel', () => {
  it('waits longer after each failure, up to a minute', () => {
    expect(userChannelRetryDelay(0)).toBe(USER_CHANNEL_RETRY_MIN_MS)
    expect(userChannelRetryDelay(1)).toBe(2 * USER_CHANNEL_RETRY_MIN_MS)
    expect(userChannelRetryDelay(3)).toBe(40_000)
    expect(userChannelRetryDelay(4)).toBe(USER_CHANNEL_RETRY_MAX_MS)
    expect(userChannelRetryDelay(1_000)).toBe(USER_CHANNEL_RETRY_MAX_MS)
    expect(userChannelRetryDelay(-1)).toBe(USER_CHANNEL_RETRY_MIN_MS)
  })
})
