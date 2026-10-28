/** What the Cloudflare token needs, shown on both the setup and connect screens. */
export const TOKEN_URL = 'https://dash.cloudflare.com/profile/api-tokens'
export const R2_TOKEN_HELP = 'https://dash.cloudflare.com/?to=/:account/r2/api-tokens'

export const PERMISSIONS = [
  ['Account', 'Account Settings', 'Read'],
  ['Account', 'Workers R2 Storage', 'Edit'],
  ['Account', 'Workers Scripts', 'Edit'],
  ['Account', 'D1', 'Edit'],
  ['Zone (optional)', 'Zone', 'Read'],
]
