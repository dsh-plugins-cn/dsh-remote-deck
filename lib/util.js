import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, posix } from 'node:path'

export const MARKER = '.dsh-remote.json'
export const MAX_TEXT_BYTES = 8 * 1024 * 1024
export const HOST_COLORS = ['blue', 'teal', 'violet', 'amber', 'rose', 'cyan']

export function nowIso() {
  return new Date().toISOString()
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

export function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJsonFile(path, value, mode) {
  ensureDir(dirname(path))
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: mode || 0o600 })
}

export function fsError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export function normalizeRemotePath(value) {
  const normalized = posix.normalize(String(value || '/'))
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

export function isPosixPath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
}

export function slugFor(remotePath) {
  const base = basename(remotePath) || 'root'
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'root'
  const hash = createHash('sha1').update(remotePath).digest('hex').slice(0, 8)
  return `${clean}-${hash}`
}

export function statusSftpError(error) {
  if (error === undefined || error === null) return fsError('FS_IO_ERROR', 'unknown SSH/SFTP failure')
  const code = error.code
  if (code === 2) return fsError('FS_NOT_FOUND', error.message || 'no such file')
  if (code === 3) return fsError('FS_ACCESS_DENIED', error.message || 'permission denied')
  if (code === 4) return fsError('FS_IO_ERROR', error.message || 'failure')
  return fsError('FS_IO_ERROR', error.message || String(error))
}

export function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (error, value) => (error ? reject(statusSftpError(error)) : resolve(value)))
  })
}

export function attrsVersion(attrs) {
  return `${Math.floor((attrs.mtime || 0) * 1000)}:${attrs.size || 0}`
}

export function attrsType(attrs) {
  if (attrs.isDirectory && attrs.isDirectory()) return 'directory'
  if (attrs.isFile && attrs.isFile()) return 'file'
  if (attrs.isSymbolicLink && attrs.isSymbolicLink()) return 'symlink'
  return 'other'
}

export function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}
