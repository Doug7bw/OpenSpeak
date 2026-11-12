// Cada reprodução guarda suas peças em uma pasta privada da origem.
export class TorrentPieceStore {
  #name = 'openspeak-torrent-' + crypto.randomUUID();
  #root;
  #directory;
  #pending = new Set();
  #closed = false;

  put(index, bytes, callback) {
    this.#run(async directory => {
      const file = await directory.getFileHandle(String(index), { create: true });
      const writable = await file.createWritable();
      try {
        await writable.write(bytes);
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => {});
        throw error;
      }
    }, callback);
  }

  get(index, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    this.#run(async directory => {
      const handle = await directory.getFileHandle(String(index));
      const file = await handle.getFile();
      const start = options?.offset ?? 0;
      const end = options?.length === undefined ? file.size : start + options.length;
      return new Uint8Array(await file.slice(start, end).arrayBuffer());
    }, callback);
  }

  close(callback) {
    this.#drain().then(() => callback(null));
  }

  destroy(callback) {
    this.#drain().then(async () => {
      if (!this.#directory) return;
      await this.#directory.catch(() => {});
      const root = await this.#root;
      await root.removeEntry(this.#name, { recursive: true }).catch(error => {
        if (error.name !== 'NotFoundError') throw error;
      });
    }).then(() => callback(null), callback);
  }

  #drain() {
    this.#closed = true;
    return Promise.allSettled(this.#pending);
  }

  #run(operation, callback) {
    if (this.#closed) {
      queueMicrotask(() => callback(new Error('Armazenamento de peças encerrado')));
      return;
    }
    this.#root ??= navigator.storage.getDirectory();
    this.#directory ??= this.#root.then(root => root.getDirectoryHandle(this.#name, { create: true }));
    const result = this.#directory.then(operation);
    this.#pending.add(result);
    result.then(value => {
      this.#pending.delete(result);
      callback(null, value);
    }, error => {
      this.#pending.delete(result);
      callback(error);
    });
  }
}
