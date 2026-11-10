// Compiles java/UblHelper.java against the bundled Saxon-HE (portable classpath separator).
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const lib = path.join(root, 'lib');
const classpath = [path.join(lib, 'Saxon-HE-12.10.jar'), path.join(lib, 'xmlresolver-5.3.3.jar')].join(path.delimiter);

execFileSync('javac', [
    '--release', '11',
    '-cp', classpath,
    '-d', path.join(lib, 'classes'),
    path.join(root, 'java', 'UblHelper.java'),
], { stdio: 'inherit' });
