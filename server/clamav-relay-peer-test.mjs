// Synthetic test peer only. No files, engine socket, environment-selected
// endpoint, protocol interpretation, content logs or acceptance decision.
import {Socket} from 'node:net';
const socket=new Socket();let ended=false;
const stop=() => {process.exitCode=1;socket.destroy();process.stdin.destroy();process.stdout.end();};
socket.once('error',stop);process.stdin.once('error',stop);process.stdout.once('error',stop);
socket.once('connect',() => {process.stdin.pipe(socket);socket.pipe(process.stdout,{end:false});});
socket.once('end',() => {ended=true;process.stdin.destroy();process.stdout.end();});
socket.once('close',() => {if(!ended)stop();});
socket.connect(3310,'127.0.0.1');
