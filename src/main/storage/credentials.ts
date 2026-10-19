import { safeStorage } from "electron";
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export class Credentials {
  private readonly file: string;
  constructor(private readonly directory: string) { this.file = path.join(directory, "deepseek.bin"); }
  present() { return existsSync(this.file); }
  private safeFile() {
    if (existsSync(this.file) && (lstatSync(this.file).isSymbolicLink() || lstatSync(this.file).size > 4096)) throw new Error("KEY_STORAGE_UNSAFE");
  }
  async save(key: string) {
    if (!/^sk-[A-Za-z0-9_-]{16,200}$/.test(key)) throw new Error("API_INVALID_KEY_FORMAT");
    if (process.platform !== "win32" || !await safeStorage.isAsyncEncryptionAvailable()) throw new Error("KEY_ENCRYPTION_UNAVAILABLE");
    this.safeFile();
    const encrypted = await safeStorage.encryptStringAsync(key);
    const temp = path.join(this.directory, `${randomUUID()}.key-tmp`);
    writeFileSync(temp, encrypted, { flag: "wx", mode: 0o600 });
    renameSync(temp, this.file);
  }
  async read() {
    this.safeFile();
    if (!this.present()) throw new Error("KEY_MISSING");
    if (process.platform !== "win32" || !await safeStorage.isAsyncEncryptionAvailable()) throw new Error("KEY_ENCRYPTION_UNAVAILABLE");
    const decrypted = await safeStorage.decryptStringAsync(readFileSync(this.file));
    if (!/^sk-[A-Za-z0-9_-]{16,200}$/.test(decrypted.result)) throw new Error("KEY_INVALID");
    if (decrypted.shouldReEncrypt) await this.save(decrypted.result);
    return decrypted.result;
  }
  remove() { this.safeFile(); if (this.present()) unlinkSync(this.file); }
}
