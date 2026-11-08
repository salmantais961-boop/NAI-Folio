use std::{
    fmt::Write as _,
    io::{self, BufRead, BufReader, Read, Write},
    os::windows::process::CommandExt,
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

pub struct Bridge {
    child: Child,
    pub token: String,
    pub port: u16,
}

impl Bridge {
    pub fn start(root: &Path) -> io::Result<Self> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
        let mut token = String::with_capacity(64);
        for byte in bytes {
            write!(token, "{byte:02x}").expect("writing to a String");
        }
        let child = Command::new(root.join("runtime").join("node.exe"))
            .arg(root.join("bridge.mjs"))
            .current_dir(root)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()?;
        // The guard owns the child before any fallible handshake operation.
        let mut bridge = Self {
            child,
            token,
            port: 0,
        };
        let input = bridge.child.stdin.as_mut().unwrap();
        writeln!(input, "{}", bridge.token)?;
        input.flush()?;
        let output = bridge.child.stdout.take().unwrap();
        let (send, receive) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut reader = BufReader::new(output);
            let mut line = String::new();
            let result = reader
                .by_ref()
                .take(1024)
                .read_line(&mut line)
                .map(|_| line);
            let _ = send.send(result);
            let _ = io::copy(&mut reader, &mut io::sink());
        });
        let line = receive
            .recv_timeout(Duration::from_secs(15))
            .map_err(|_| io::Error::other("本地 API 服务启动超时。"))??;
        bridge.port = serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .and_then(|v| v.get("port")?.as_u64())
            .and_then(|n| u16::try_from(n).ok())
            .filter(|n| *n != 0)
            .ok_or_else(|| io::Error::other("本地 API 服务未能启动。请检查 backend 目录。"))?;
        Ok(bridge)
    }

    pub fn has_exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)))
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        // If the host is forcibly terminated, the pipe also closes and the
        // companion exits itself. On a normal exit always reap it here.
        drop(self.child.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
