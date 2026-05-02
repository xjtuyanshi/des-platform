import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ShuttlePrerequisiteReport = {
  checkedAt: string;
  host: {
    modelName: string | null;
    modelIdentifier: string | null;
    chip: string | null;
    memory: string | null;
    metalSupport: string | null;
    macos: string | null;
  };
  unreal: {
    installedCandidates: string[];
    preferredVersion: '5.7.4';
    status: 'ready' | 'blocked';
    notes: string[];
  };
  xcode: {
    developerDir: string | null;
    version: string | null;
    status: 'ready' | 'blocked';
    notes: string[];
  };
  pixelStreaming: {
    status: 'pending-unreal' | 'ready';
    notes: string[];
  };
};

async function commandOutput(command: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 10000 });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error && 'stderr' in error) {
      const failed = error as { stdout?: string; stderr?: string; message?: string };
      return `${failed.stdout ?? ''}${failed.stderr ?? ''}${failed.message ?? ''}`.trim();
    }
    return String(error);
  }
}

function extractLineValue(text: string, label: string): string | null {
  const line = text.split('\n').find((candidate) => candidate.trim().startsWith(`${label}:`));
  return line ? line.split(':').slice(1).join(':').trim() : null;
}

export async function collectPrerequisites(): Promise<ShuttlePrerequisiteReport> {
  const [hardware, displays, swVers, xcodeSelect, xcodeBuild, applications] = await Promise.all([
    commandOutput('system_profiler', ['SPHardwareDataType']),
    commandOutput('system_profiler', ['SPDisplaysDataType']),
    commandOutput('sw_vers', []),
    commandOutput('xcode-select', ['-p']),
    commandOutput('xcodebuild', ['-version']),
    commandOutput('find', ['/Applications', '-maxdepth', '2', '(', '-iname', '*Unreal*', '-o', '-iname', '*Epic*', '-o', '-iname', '*Xcode*', ')', '-print'])
  ]);

  const installedCandidates = applications.split('\n').filter(Boolean).sort();
  const hasUnreal = installedCandidates.some((candidate) => /Unreal|UE_5\.7|Epic Games/i.test(candidate));
  const hasFullXcode = /^Xcode\s+\d+/m.test(xcodeBuild);
  const activeDeveloperDir = xcodeSelect.includes('xcode-select: error') ? null : xcodeSelect.split('\n')[0] ?? null;

  return {
    checkedAt: new Date().toISOString(),
    host: {
      modelName: extractLineValue(hardware, 'Model Name'),
      modelIdentifier: extractLineValue(hardware, 'Model Identifier'),
      chip: extractLineValue(hardware, 'Chip'),
      memory: extractLineValue(hardware, 'Memory'),
      metalSupport: extractLineValue(displays, 'Metal Support'),
      macos: extractLineValue(swVers, 'ProductVersion')
    },
    unreal: {
      installedCandidates,
      preferredVersion: '5.7.4',
      status: hasUnreal ? 'ready' : 'blocked',
      notes: hasUnreal
        ? ['Unreal/Epic application candidate found under /Applications. Verify the project uses UE 5.7.4 before Pixel Streaming validation.']
        : ['No Unreal Engine or Epic Games Launcher application was found under /Applications during this check.']
    },
    xcode: {
      developerDir: activeDeveloperDir,
      version: hasFullXcode ? xcodeBuild.split('\n')[0] ?? null : null,
      status: hasFullXcode ? 'ready' : 'blocked',
      notes: hasFullXcode
        ? ['Full Xcode toolchain is available.']
        : ['xcodebuild did not report a full Xcode installation; the active developer directory appears to be Command Line Tools only.']
    },
    pixelStreaming: {
      status: hasUnreal ? 'ready' : 'pending-unreal',
      notes: [
        'Pixel Streaming validation requires a packaged or Standalone Unreal app with the Pixel Streaming plugin enabled.',
        'The API/dashboard protocol can be validated independently before Unreal is installed.'
      ]
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await collectPrerequisites(), null, 2));
}
