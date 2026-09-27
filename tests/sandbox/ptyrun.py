#!/usr/bin/env python3
"""Run a command in a pseudo-terminal, headless, the way a terminal tab would host it.

  ptyrun.py <log> <fifo> <seconds> -- cmd args...

Output (ANSI stripped) goes to <log>; anything written to <fifo> is typed into the program.
Ends after <seconds>, or when the program exits. Used by the sandbox to host an INTERACTIVE
Claude session, which `claude agents` reports as kind=interactive -- the same kind a Claude
window or a terminal hosts.
"""
import os, pty, re, select, signal, sys, time
log, fifo, secs = sys.argv[1], sys.argv[2], float(sys.argv[3])
cmd = sys.argv[sys.argv.index('--') + 1:]
if not os.path.exists(fifo):
    os.mkfifo(fifo)
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
ansi = re.compile(rb'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]')
ff = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
end = time.time() + secs
with open(log, 'ab') as out:
    while time.time() < end:
        r, _, _ = select.select([fd, ff], [], [], 0.5)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            out.write(ansi.sub(b'', data)); out.flush()
        if ff in r:
            data = os.read(ff, 65536)
            if data:
                # a person types, then presses Enter: send the text, then a carriage return
                os.write(fd, data.rstrip(b'\n')); time.sleep(0.3); os.write(fd, b'\r')
        try:
            if os.waitpid(pid, os.WNOHANG)[0]:
                break
        except ChildProcessError:
            break
try:
    os.kill(pid, signal.SIGTERM)
except ProcessLookupError:
    pass
