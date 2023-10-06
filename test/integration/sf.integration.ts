import {Interfaces} from '@oclif/core'
import {expect} from 'chai'
import {default as got} from 'got'
import {ExecOptions, exec as cpExec} from 'node:child_process'
import {createWriteStream} from 'node:fs'
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const makeTestDir = async (): Promise<string> => {
  const tmpDir = join(tmpdir(), 'sf-update-test')
  // ensure that we are starting with a clean directory
  try {
    await rm(tmpDir, {force: true, recursive: true})
  } catch {
    // error means that folder doesn't exist which is okay
  }

  await mkdir(tmpDir, {recursive: true})
  return tmpDir
}

const download = async (url: string, location: string): Promise<void> => {
  console.log(`Downloading ${url} to ${location}`)
  const downloadStream = got.stream(url)
  const fileWriterStream = createWriteStream(location)
  return new Promise((resolve, reject) => {
    downloadStream.on('error', (error) => {
      reject(new Error(`Download failed: ${error.message}`))
    })

    fileWriterStream
      .on('error', (error) => {
        reject(new Error(`Could not write file to system: ${error.message}`))
      })
      .on('finish', () => {
        console.log('Success!')
        resolve()
      })
    downloadStream.pipe(fileWriterStream)
  })
}

const exec = async (
  command: string,
  options?: ExecOptions,
): Promise<{code: number; stderr: string; stdout: string}> => {
  const opts = process.platform === 'win32' ? {...options, shell: 'powershell.exe'} : options ?? {}
  return new Promise((resolve, reject) => {
    cpExec(command, opts, (error, stdout, stderr) => {
      if (error) {
        console.log('Error!', error)
        reject(error)
      } else {
        resolve({code: 0, stderr, stdout})
      }
    })
  })
}

async function readJSON<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

describe('sf integration', () => {
  let testDir: string
  let dataDir: string
  let cacheDir: string
  let configDir: string
  let initialVersion: string
  let stableVersion: string
  let sf: string

  const versionToUpdateTo = '2.12.7-esm.0'
  const channel = 'nightly'

  const tarball =
    process.platform === 'win32'
      ? `https://developer.salesforce.com/media/salesforce-cli/sf/channels/${channel}/sf-win32-x64.tar.gz`
      : `https://developer.salesforce.com/media/salesforce-cli/sf/channels/${channel}/sf-linux-x64.tar.gz`

  before(async () => {
    console.log('Setting up test environment...')

    const {stdout} = await exec('npm view @salesforce/cli --json')
    const distTags = JSON.parse(stdout)['dist-tags']

    stableVersion = distTags.latest

    testDir = await makeTestDir()
    console.log(`Test directory: ${testDir}`)

    dataDir = join(testDir, 'data')
    cacheDir = join(testDir, 'cache')
    configDir = join(testDir, 'config')

    await mkdir(dataDir, {recursive: true})
    await mkdir(cacheDir, {recursive: true})
    await mkdir(configDir, {recursive: true})

    process.env.SF_DATA_DIR = dataDir
    process.env.SF_CACHE_DIR = cacheDir
    process.env.SF_CONFIG_DIR = configDir

    console.log('• data directory:', dataDir)
    console.log('• cache directory:', cacheDir)
    console.log('• config directory:', configDir)

    const tarLocation = join(testDir, tarball.split('/').at(-1) ?? 'sf.tar.xz')
    const extractedLocation = join(testDir, 'sf')
    await mkdir(extractedLocation, {recursive: true})

    await download(tarball, tarLocation)
    const cmd =
      process.platform === 'win32'
        ? `tar -xf ${tarLocation} -C ${extractedLocation} --strip-components 1 --exclude node_modules/.bin`
        : `tar -xf ${tarLocation} -C ${extractedLocation} --strip-components 1`

    console.log(`Extracting ${tarLocation} to ${extractedLocation}`)
    const extractResult = await exec(cmd, {cwd: testDir})
    console.log(extractResult.stdout)
    expect(extractResult.code).to.equal(0)
    console.log('Success!')

    console.log('Testing that installation was successful...')
    // It's important to use run.js instead of sf - otherwise it will resolve to the global version of sf
    sf = join(extractedLocation, 'bin', 'run.js')
    // set the bin path so that plugin-update thinks this is updatable
    // This would typically be set by the sf executable that's included in the tarball
    // but since we're using bin/run.js to avoid the global sf, we need to set it manually
    process.env.SF_BINPATH = sf
    const versionResult = await exec(`${sf} version --json`)
    console.log(versionResult.stdout)
    expect(versionResult.code).to.equal(0)
    initialVersion = JSON.parse(versionResult.stdout).cliVersion.replace('@salesforce/cli/', '')
    console.log('Success!')

    console.log('Linking plugin-update...')
    // Running `plugins link` is very slow on github-action's windows runners. Writing this file
    // directly is much faster and accomplishes the same thing (except for re-installing deps)
    const userPjson = {
      dependencies: {},
      oclif: {
        plugins: [{name: '@oclif/plugin-update', root: process.cwd(), type: 'link'}],
      },
      private: true,
    }
    await writeFile(join(dataDir, 'package.json'), JSON.stringify(userPjson, null, 2))

    const pluginsResults = await exec(`${sf} plugins`, {cwd: testDir})
    console.log(pluginsResults.stdout)
    expect(pluginsResults.code).to.equal(0)
    const isLinked = /@oclif\/plugin-update (.*?) \(link\) /.test(pluginsResults.stdout)
    expect(isLinked).to.be.true
    console.log('Success!')
    console.log('Test setup complete.')
  })

  it('should update sf to a specific version', async () => {
    const {code} = await exec(`${sf} update --version ${versionToUpdateTo}`)
    expect(code).to.equal(0)

    const clientDir = join(dataDir, 'client')
    const items = await readdir(clientDir)
    expect(
      items.some((i) => i.startsWith(versionToUpdateTo)),
      'new version to be added to client directory',
    ).to.be.true

    const {version} = await readJSON<Interfaces.PJSON>(join(dataDir, 'client', 'current', 'package.json'))
    expect(version, 'version in SF_DATA_DIR/client/current to be the updated version').to.equal(versionToUpdateTo)
    expect(version).to.not.equal(initialVersion)
  })

  it('should update sf to the latest version of a channel', async () => {
    const {code} = await exec(`${sf} update stable`)
    expect(code).to.equal(0)

    const clientDir = join(dataDir, 'client')
    const items = await readdir(clientDir)
    expect(
      items.some((i) => i.startsWith(stableVersion)),
      'new version to be added to client directory',
    ).to.be.true

    const {version} = await readJSON<Interfaces.PJSON>(join(dataDir, 'client', 'current', 'package.json'))
    expect(version, 'version in SF_DATA_DIR/client/current to be the updated version').to.equal(stableVersion)
  })
})
