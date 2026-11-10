import { execFile } from 'child_process';
import { promisify } from 'util';

const execFilePromise = promisify(execFile);

export function execAsync(
    command: string,
    args: string[],
    options?: { maxBuffer?: number }
): Promise<{ stdout: string; stderr: string }> {
    return execFilePromise(command, args, {
        maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024,
    });
}
