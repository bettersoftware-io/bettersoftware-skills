// Prints the arguments it was started with, as one line of JSON. The shell
// tests put it where `git` or `gh` would be, to see exactly which words a
// shell passes on.

process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\n`);
