const fs = require('node:fs');
const path = require('node:path');
class CredentialStore {
  constructor(directory, safeStorage) { this.file = path.join(directory, 'deepseek-key.enc'); this.safeStorage = safeStorage; }
  exists() { return fs.existsSync(this.file); }
  load() {
    if (!this.exists()) return '';
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('系统密钥保护暂不可用，请在编辑器重新导入密钥。');
    try { return this.safeStorage.decryptString(fs.readFileSync(this.file)); }
    catch { throw new Error('本机保存的 DeepSeek 密钥无法解密，请重新导入。'); }
  }
  save(key) {
    if (typeof key !== 'string' || !key.trim() || key.length > 512 || /\s/.test(key.trim())) throw new Error('请输入有效的 DeepSeek API Key。');
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，本次未保存密钥。');
    const encrypted = this.safeStorage.encryptString(key.trim());
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, encrypted, { mode: 0o600 });
    fs.renameSync(temp, this.file);
    return key.trim();
  }
  importFile(file) {
    const content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    const candidates = [...new Set(content.match(/sk-[A-Za-z0-9_-]{16,}/g) || [])];
    if (candidates.length !== 1) throw new Error('密钥文件需包含一个有效 DeepSeek Key，请检查文件。');
    return this.save(candidates[0]);
  }
}
module.exports = { CredentialStore };
