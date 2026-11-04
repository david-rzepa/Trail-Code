import { verify } from './verification.js';
const controller=new AbortController();
process.on('SIGTERM',()=>controller.abort());
process.on('SIGINT',()=>controller.abort());
const report=await verify({cwd:process.cwd(),argv:process.argv.slice(2)}, {signal:controller.signal,onChildOutput:(_stream,text)=>process.stderr.write(text)});
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode=report.exit_code;
