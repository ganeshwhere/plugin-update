import makeDebug from 'debug';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { copyFile, renameSync } from 'node:fs/promises';
import { join } from 'node:path';

import { touch } from './util.js';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Headers, extract as tarExtract } from 'tar-fs';

const debug = makeDebug('oclif-update');

const ignore = (_name, header) => {
  switch (header?.type) {
    case 'directory':
    case 'file':
      if (process.env.OCLIF_DEBUG_UPDATE_FILES) debug(header.name);
      return false;
    case 'symlink':
      return true;
    default:
      throw new Error(header?.type);
  }
};

async function extract(stream, basename, output, sha) {
  const getTmp = () => `${output}.partial.${Math.random().toString(36).slice(2)}`;
  const tmp = getTmp();
  debug(`extracting to ${tmp}`);

  try {
    await new Promise((resolve, reject) => {
      let shaValidated = false;
      let extracted = false;

      const check = () => {
        if (shaValidated && extracted) {
          resolve();
        }
      };

      if (sha) {
        const hasher = crypto.createHash('sha256');
        stream.on('error', reject);
        stream.on('data', (d) => hasher.update(d));
        stream.on('end', () => {
          const shasum = hasher.digest('hex');
          if (sha === shasum) {
            shaValidated = true;
            check();
          } else {
            reject(new Error(`SHA mismatch: expected ${shasum} to be ${sha}`));
          }
        });
      } else {
        shaValidated = true;
      }

      const extractStream = tarExtract(tmp, { ignore });
      extractStream.on('error', reject);
      extractStream.on('finish', () => {
        extracted = true;
        check();
      });

      const gunzip = zlib.createGunzip();
      gunzip.on('error', reject);

      stream.pipe(gunzip).pipe(extractStream);
    });

    if (!existsSync(output)) {
      mkdirSync(output, { recursive: true });
    }

    const from = join(tmp, basename);
    debug(`moving ${from} to ${output}`);
    await renameSync(from, join(output, basename));
    await touch(join(output, basename));
    debug('done extracting');
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch (error) {
      debug(error);
    }
  }
}

export const Extractor = {
  extract,
};
