export const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
export const digitsOnly = (s) => String(s ?? '').replace(/\D+/g, '')
