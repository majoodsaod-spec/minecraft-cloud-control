"""Authenticated outbound live-control client for a transient Paper runner.

Only connects to the configured Cloudflare Worker; no inbound admin socket.
Never includes the bridge token in console output.
"""
from __future__ import annotations
from collections import deque
from pathlib import Path
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request

USERNAME = re.compile(r"^[A-Za-z0-9_]{3,16}$")
SAFE_PATH = re.compile(r"^[A-Za-z0-9_./ ()-]+$")
TEXT_SUFFIXES = {".txt",".json",".yml",".yaml",".properties",".conf",".cfg",".toml",".log",".md"}
MAX_FILE = 256 * 1024


class LiveBridge:
    def __init__(self, data: Path, session: str, players: set, lock, log_lines, ready, send, restart_event):
        self.data=data.resolve()
        self.session=session
        self.players=players
        self.lock=lock
        self.log_lines=log_lines
        self.ready=ready
        self.send=send
        self.restart_event=restart_event
        self.url=os.environ.get("CLOUDFLARE_CONTROL_URL", "").rstrip("/")
        self.token=os.environ.get("CLOUDFLARE_BRIDGE_TOKEN", "")
        self.acked=deque(maxlen=50)
        self.seen=set()
        self.started=time.monotonic()
        self.thread=None

    def start(self):
        if not self.url or not self.token:
            print("Cloudflare live bridge not configured; console and player controls unavailable",flush=True)
            return
        if not self.url.startswith("https://"):
            raise ValueError("Cloudflare bridge requires HTTPS")
        self.thread=threading.Thread(target=self._loop,daemon=True)
        self.thread.start()
        print("Cloudflare live bridge enabled",flush=True)

    def _request(self, payload):
        request=urllib.request.Request(
            self.url+"/api/bridge",
            data=json.dumps(payload).encode(),
            headers={"Authorization":"Bearer "+self.token,"Content-Type":"application/json",
                     "User-Agent":"minecraft-cloud-bridge/1"},
            method="POST",
        )
        with urllib.request.urlopen(request,timeout=15) as reply:
            return json.load(reply)

    def _path(self, relative, write=False):
        if not isinstance(relative,str) or not relative or len(relative)>180 or not SAFE_PATH.fullmatch(relative):
            raise ValueError("Invalid relative path")
        path=Path(relative)
        if path.is_absolute() or any(part in (".","..","") for part in path.parts):
            raise ValueError("Invalid relative path")
        resolved=(self.data/path).resolve()
        if not resolved.is_relative_to(self.data):
            raise ValueError("File escapes server directory")
        if write and (relative.startswith(("world/","world_nether/","world_the_end/")) or
                      resolved.suffix.lower() not in TEXT_SUFFIXES or resolved.name in ("eula.txt","ops.json","banned-players.json")):
            raise ValueError("Live write forbidden for world data, binary files and protected permissions")
        return resolved

    def _execute(self, item):
        kind=item.get("type","")
        args=item.get("args") or {}
        def user():
            name=args.get("player","")
            if not isinstance(name,str) or not USERNAME.fullmatch(name):raise ValueError("Invalid player name")
            return name
        if kind=="console":
            cmd=args.get("command")
            if not isinstance(cmd,str) or not 0<len(cmd)<=240 or "\n" in cmd or "\r" in cmd:
                raise ValueError("Invalid console command")
            if cmd.lower().lstrip("/").strip() in ("stop","restart"):
                raise ValueError("Use the safe restart button for server shutdown")
            self.send(cmd.lstrip("/"))
            return "Sent to Paper console"
        if kind in ("kick","ban","pardon","whitelist-add","whitelist-remove","op","deop"):
            who=user()
            cmd={
                "kick":"kick","ban":"ban","pardon":"pardon","whitelist-add":"whitelist add",
                "whitelist-remove":"whitelist remove","op":"op","deop":"deop"
            }[kind]
            self.send(cmd+" "+who)
            return cmd+" "+who+" sent"
        if kind in ("whitelist-on","whitelist-off"):
            self.send("whitelist "+kind.split("-")[1])
            return kind+" sent"
        if kind=="save":
            self.send("save-all flush")
            return "Save-all flush requested; backup artifact requires graceful restart"
        if kind=="restart":
            self.restart_event.set()
            return "Graceful backup/restart requested"
        if kind=="plugins-list":
            return [{"name":p.name,"bytes":p.stat().st_size} for p in (self.data/"plugins").glob("*.jar")][:100]
        if kind=="files-list":
            base=self._path(args.get("path",".")) if args.get("path") not in (None,"","." ) else self.data
            if not base.is_dir():raise ValueError("Directory not found")
            return [{"name":p.name,"path":p.relative_to(self.data).as_posix(),
                    "type":"dir" if p.is_dir() else "file","size":p.stat().st_size if p.is_file() else None}
                    for p in sorted(base.iterdir(),key=lambda x:(not x.is_dir(),x.name.lower()))[:150]
                    if not p.is_symlink()]
        if kind in ("files-read","files-write","files-delete"):
            relative=args.get("path","")
            path=self._path(relative,write=kind!="files-read")
            if path.suffix.lower() not in TEXT_SUFFIXES:raise ValueError("Only small text files are supported")
            if kind=="files-read":
                if not path.is_file():raise ValueError("File not found")
                if path.stat().st_size>MAX_FILE:raise ValueError("File too large")
                return {"path":relative,"content":path.read_text(encoding="utf-8")}
            if kind=="files-write":
                value=args.get("content")
                if not isinstance(value,str) or len(value.encode())>MAX_FILE:raise ValueError("Content must be text <=256 KiB")
                path.parent.mkdir(parents=True,exist_ok=True)
                path.write_text(value,encoding="utf-8")
                return "Saved to runner filesystem; included in next verified backup"
            if not path.is_file():raise ValueError("File not found")
            path.unlink()
            return "File deleted; deletion captured at next backup"
        raise ValueError("Unsupported command")

    def _loop(self):
        while not self.restart_event.is_set():
            with self.lock:
                players=sorted(self.players)
                logs=list(self.log_lines)[-60:]
            status={"ready":self.ready.is_set(),"players":players,"logs":logs,
                    "uptime":int(time.monotonic()-self.started)}
            outgoing=list(self.acked)
            try:
                incoming=self._request({"session":self.session,"status":status,"acks":outgoing})
                self.acked.clear()
                for command in incoming.get("commands",[]):
                    cid=command.get("id")
                    if not isinstance(cid,str) or cid in self.seen:continue
                    self.seen.add(cid)
                    try:
                        result=self._execute(command)
                        self.acked.append({"id":cid,"type":command.get("type"),"ok":True,"result":result})
                    except Exception as exc:
                        self.acked.append({"id":cid,"type":command.get("type"),"ok":False,"result":str(exc)})
                if len(self.seen)>1000:self.seen=set(list(self.seen)[-250:])
            except (urllib.error.URLError,TimeoutError,OSError,ValueError) as exc:
                print("Cloudflare bridge unavailable (retrying):",type(exc).__name__,flush=True)
            time.sleep(5)
