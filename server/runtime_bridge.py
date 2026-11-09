"""Authenticated outbound live-control client for a transient Paper runner.

Only connects to the configured Cloudflare Worker; no inbound admin socket.
Never includes the bridge token in console output.
"""
from __future__ import annotations
from collections import deque
try:
    from .modrinth_install import install_modrinth, installed_inventory
except ImportError:  # Launched as python server/continuous_paper.py
    from modrinth_install import install_modrinth, installed_inventory
from pathlib import Path
try:
    from .performance_history import PerformanceHistory
except ImportError:
    from performance_history import PerformanceHistory
import base64
import binascii
import json
import os
import re
import shutil
import threading
import time
import urllib.error
import urllib.request

USERNAME = re.compile(r"^(?:[A-Za-z0-9_]{3,16}|\.[A-Za-z0-9_]{1,16})$")
SAFE_PATH = re.compile(r"^[A-Za-z0-9_./ ()+@,\[\]-]+$")
TEXT_SUFFIXES = {".txt",".json",".yml",".yaml",".properties",".conf",".cfg",".toml",".log",".md"}
MAX_FILE = 256 * 1024


def unsafe_shutdown_command(command: str) -> bool:
    """Reserve every namespaced Paper/Bukkit stop or restart for safe handoff."""
    first = command.strip().lstrip("/").split(maxsplit=1)
    if not first:
        return False
    verb = first[0].lower().split(":")[-1]
    return verb in {"stop", "restart"}



class LiveBridge:
    def __init__(self, data: Path, session: str, players: set, lock, log_lines, ready, send, restart_event, shutdown_event, observed, paper_pid, metrics=None):
        self.data=data.resolve()
        self.session=session
        self.players=players
        self.lock=lock
        self.log_lines=log_lines
        self.ready=ready
        self.send=send
        self.restart_event=restart_event
        self.shutdown_event=shutdown_event
        self.observed=observed
        self.paper_pid=paper_pid
        self.metrics=metrics
        self.performance_history=PerformanceHistory(self.data)
        self.url=os.environ.get("CLOUDFLARE_CONTROL_URL", "").rstrip("/")
        self.token=os.environ.get("CLOUDFLARE_BRIDGE_TOKEN", "")
        self.acked=deque(maxlen=50)
        self.seen=set()
        self.started=time.monotonic()
        self.lifecycle_phase="starting"
        self.startup_timings={}
        self.thread=None
        self._failures=0
        self._last_failure=""
        self._cpu_sample=None

    def start(self):
        if not self.url or not self.token:
            print("Cloudflare live bridge not configured; console and player controls unavailable",flush=True)
            return
        if not self.url.startswith("https://"):
            print("Cloudflare live bridge disabled: control URL must use HTTPS", flush=True)
            # Also suppress later phase() requests, which would otherwise
            # transmit the bearer token over an insecure HTTP connection.
            self.url = ""
            self.token = ""
            return
        self.thread=threading.Thread(target=self._loop,daemon=True)
        self.thread.start()
        print("Cloudflare live bridge enabled",flush=True)

    def _request(self, payload, route="/api/bridge"):
        request=urllib.request.Request(
            self.url+route,
            data=json.dumps(payload).encode(),
            headers={"Authorization":"Bearer "+self.token,"Content-Type":"application/json",
                     "User-Agent":"minecraft-cloud-bridge/1"},
            method="POST",
        )
        with urllib.request.urlopen(request,timeout=15) as reply:
            return json.load(reply)

    def phase(self, phase, detail=""):
        """Best effort status event; failure never interrupts world saving."""
        self.lifecycle_phase=phase
        if not self.url or not self.token:
            return
        try:
            self._request({"session":self.session,"phase":phase,"detail":detail}, "/api/bridge-event")
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            print("Could not report dashboard lifecycle phase:",type(exc).__name__,flush=True)

    def _path(self, relative, write=False):
        if not isinstance(relative,str) or not relative or len(relative)>180 or not SAFE_PATH.fullmatch(relative):
            raise ValueError("Invalid relative path")
        path=Path(relative)
        if path.is_absolute() or any(part in (".","..","") for part in path.parts):
            raise ValueError("Invalid relative path")
        resolved=(self.data/path).resolve()
        if not resolved.is_relative_to(self.data):
            raise ValueError("File escapes server directory")
        # Never expose authentication material, private player data or secret
        # runtime files to a browser, even if a dashboard password is compromised.
        resolved_parts=resolved.relative_to(self.data).parts
        parts={part.lower() for part in (*path.parts,*resolved_parts)}
        if any(p.startswith(".") for p in (*path.parts,*resolved_parts)) or resolved.name.lower() in (
            "key.pem","usercache.json","ops.json","whitelist.json",
            "banned-players.json","banned-ips.json","eula.txt",
            "credentials.json","secrets.json"
        ) or (
            "geyser-spigot" in parts and resolved.name.lower()=="config.yml"
        ):
            raise ValueError("This file is protected")
        if write and (any(part in ("world","world_nether","world_the_end") or part.startswith("world_")
                          for part in (*path.parts,*resolved_parts)) or
                      "playerdata" in parts or "stats" in parts or
                      "advancements" in parts or
                      path.parts[0] in ("plugins",) and resolved.suffix.lower()==".jar" or
                      resolved.name.lower()=="server.properties"):
            raise ValueError("This file is protected. Use Server Settings for server.properties.")
        return resolved

    def _file_entry(self, path):
        stat=path.stat()
        relative=path.relative_to(self.data).as_posix()
        return {"name":path.name,"path":relative,
                "type":"dir" if path.is_dir() else "file",
                "size":stat.st_size if path.is_file() else None,
                "modified":int(stat.st_mtime*1000)}

    def _execute(self, item):
        kind=item.get("type","")
        args=item.get("args") or {}
        def user():
            name=args.get("player","")
            if not isinstance(name,str) or not USERNAME.fullmatch(name):raise ValueError("Invalid player name")
            return name
        if kind=="worlds-list":
            # Aggregate read-only world stats. Never return file paths,
            # playerdata, inventories or the contents of any level.dat.
            configured="world"
            props=self.data/"server.properties"
            try:
                for line in props.read_text(encoding="utf-8").splitlines():
                    if line.startswith("level-name="):
                        candidate=line.partition("=")[2].strip()
                        if re.fullmatch(r"[A-Za-z0-9_-]{1,64}",candidate):
                            configured=candidate
                        break
            except (OSError,UnicodeError):
                pass
            result=[]
            for name in (configured,configured+"_nether",configured+"_the_end"):
                root=self.data/name
                if root.is_symlink() or not root.is_dir():
                    continue
                files=0
                bytes_used=0
                truncated=False
                stack=[root]
                while stack:
                    folder=stack.pop()
                    try:
                        with os.scandir(folder) as entries:
                            children=list(entries)
                    except OSError:
                        continue
                    for entry in children:
                        if files>=25000:
                            truncated=True
                            stack.clear()
                            break
                        try:
                            if entry.is_symlink():
                                continue
                            if entry.is_dir(follow_symlinks=False):
                                stack.append(Path(entry.path))
                            elif entry.is_file(follow_symlinks=False):
                                files+=1
                                bytes_used+=entry.stat(follow_symlinks=False).st_size
                        except OSError:
                            continue
                result.append({"name":name,"sizeMiB":round(bytes_used/1048576,1),
                               "files":files,"truncated":truncated,
                               "hasLevelDat":(root/"level.dat").is_file()})
            return result
        if kind=="performance-history":
            return self.performance_history.snapshot()
        if kind=="players-list":
            # A read-only, privacy-minimal projection of player records.
            # Raw UUID files and playerdata never leave the runner.
            def names(filename):
                record=self.data/filename
                if not record.is_file():
                    return []
                try:
                    if record.stat().st_size>256*1024:
                        return []
                    saved=json.loads(record.read_text(encoding="utf-8"))
                    if not isinstance(saved,list):
                        return []
                except (OSError,ValueError,UnicodeError):
                    return []
                found=set()
                for entry in saved[:1000]:
                    if isinstance(entry,dict):
                        name=entry.get("name")
                        if isinstance(name,str) and USERNAME.fullmatch(name):
                            found.add(name)
                return sorted(found,key=str.lower)
            with self.lock:
                online=sorted((x for x in self.players
                               if isinstance(x,str) and USERNAME.fullmatch(x)),key=str.lower)
            properties=self.data/"server.properties"
            whitelist_enabled=None
            if properties.is_file():
                for line in properties.read_text(encoding="utf-8").splitlines():
                    if line.startswith("white-list="):
                        whitelist_enabled=line.split("=",1)[1].strip().lower()=="true"
            return {"online":online,"whitelisted":names("whitelist.json"),
                    "operators":names("ops.json"),"banned":names("banned-players.json"),
                    "whitelistEnabled":whitelist_enabled,"session":self.session}
        if kind=="console":
            cmd=args.get("command")
            if not isinstance(cmd,str) or not 0<len(cmd)<=240 or "\n" in cmd or "\r" in cmd:
                raise ValueError("Invalid console command")
            if unsafe_shutdown_command(cmd):
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
        if kind=="shutdown":
            self.shutdown_event.set()
            return "Graceful shutdown requested; backup will upload before workflow exits"
        if kind=="marketplace-install":
            result=install_modrinth(self.data,args.get("projectId"),args.get("versionId"),args.get("kind"))
            if result["kind"]=="datapack":
                # Vanilla datapacks can be reloaded without restarting Paper.
                self.send("minecraft:reload")
                result["reloadRequested"]=True
            return result
        if kind=="file-queue-receipts":
            def receipt(name):
                path=self.data/name
                if not path.is_file() or path.stat().st_size>131072:
                    return {}
                try:
                    value=json.loads(path.read_text(encoding="utf-8"))
                    if not isinstance(value,dict) or len(value)>1000:
                        return {}
                    return {str(k)[:180]:str(v)[:80] for k,v in value.items()
                            if isinstance(k,str) and isinstance(v,str)}
                except (OSError,ValueError):
                    return {}
            return {"operations":receipt(".cloud-applied-ops.json"),
                    "edits":receipt(".cloud-applied-edits.json"),
                    "content":receipt(".cloud-applied-content.json"),
                    "installed":installed_inventory(self.data)}
        if kind=="marketplace-inventory":
            return {"installed":installed_inventory(self.data),
                    "pluginFiles":[p.name for p in (self.data/"plugins").glob("*.jar")][:250],
                    "disabledPluginFiles":[p.name for p in (self.data/"plugins"/".disabled-modrinth").glob("*.jar")][:250],
                    "datapackFiles":[p.name for p in (self.data/"world/datapacks").glob("*.zip")][:250]}
        if kind=="players-inventory":
            # Only expose player names: do not return stored addresses,
            # ban reasons, credentials or raw private player data.
            def names(filename):
                path=self.data/filename
                if not path.is_file() or path.stat().st_size>1024*1024:
                    return []
                try:
                    values=json.loads(path.read_text(encoding="utf-8"))
                    if not isinstance(values,list):
                        return []
                    return sorted({name for row in values[:2000]
                        if isinstance(row,dict)
                        for name in [row.get("name")]
                        if isinstance(name,str) and USERNAME.fullmatch(name)},
                        key=str.lower)[:500]
                except (OSError,ValueError,UnicodeError):
                    return []
            settings=self.data/"server.properties"
            whitelist_enabled=False
            if settings.is_file():
                try:
                    whitelist_enabled=any(line.strip().lower()=="white-list=true"
                        for line in settings.read_text(encoding="utf-8").splitlines())
                except OSError:
                    pass
            with self.lock:
                online=sorted((name for name in self.players
                               if isinstance(name,str) and USERNAME.fullmatch(name)),
                              key=str.lower)
            return {"online":online,"known":names("usercache.json"),
                    "whitelisted":names("whitelist.json"),
                    "banned":names("banned-players.json"),
                    "operators":names("ops.json"),
                    "whitelistEnabled":whitelist_enabled}
        if kind=="plugins-list":
            return [{"name":p.name,"bytes":p.stat().st_size} for p in (self.data/"plugins").glob("*.jar")][:100]
        if kind=="files-tree":
            # A compact directory-only tree, capped to avoid bloating the
            # small Durable Object acknowledgement history.
            budget=[180]
            def walk(folder,depth):
                if budget[0]<=0:return []
                children=[]
                try:
                    dirs=sorted(folder.iterdir(),key=lambda p:p.name.lower())
                except OSError:
                    return children
                for entry in dirs:
                    if budget[0]<=0:break
                    if entry.is_symlink() or not entry.is_dir():continue
                    rel=entry.relative_to(self.data).as_posix()
                    try:self._path(rel)
                    except (ValueError,OSError):continue
                    budget[0]-=1
                    children.append({"name":entry.name,"path":rel,
                                     "children":walk(entry,depth-1) if depth>0 else []})
                return children
            return {"roots":walk(self.data,2),"truncated":budget[0]==0}
        if kind=="files-list":
            relative=args.get("path","")
            base=self.data if relative in (None,"",".") else self._path(relative)
            if not base.is_dir():raise ValueError("Directory not found")
            entries=[]
            for path in sorted(base.iterdir(),key=lambda x:(not x.is_dir(),x.name.lower())):
                if path.is_symlink():continue
                try:
                    self._path(path.relative_to(self.data).as_posix())
                    if path.is_file() or path.is_dir():
                        entries.append(self._file_entry(path))
                except (ValueError,OSError):
                    continue
                if len(entries)>=500:break
            return {"path":relative or "","entries":entries,"truncated":len(entries)>=500}
        if kind=="files-mkdir":
            path=self._path(args.get("path",""),write=True)
            if path.exists():raise ValueError("That name is already in use")
            if not path.parent.is_dir():raise ValueError("Parent folder not found")
            path.mkdir()
            return "Folder created; included in next verified backup"
        if kind=="files-rename":
            source=self._path(args.get("path",""),write=True)
            target=self._path(args.get("target",""),write=True)
            if not source.exists() or source.is_symlink():raise ValueError("Source not found")
            if target.exists() or target.parent!=source.parent:raise ValueError("Rename must stay in the same folder and not overwrite")
            if source.is_dir() and ("world" in source.parts or source.name=="plugins"):
                raise ValueError("Cannot rename protected server folders")
            source.rename(target)
            return "Renamed successfully; change saved in next backup"
        if kind=="files-download":
            path=self._path(args.get("path",""))
            if not path.is_file():raise ValueError("File not found")
            if path.stat().st_size>MAX_FILE:raise ValueError("Download exceeds 256 KiB live-transfer limit")
            return {"path":args["path"],"encoding":"base64",
                    "content":base64.b64encode(path.read_bytes()).decode("ascii")}
        if kind=="files-upload":
            path=self._path(args.get("path",""),write=True)
            if path.suffix.lower() not in TEXT_SUFFIXES:
                raise ValueError("Upload limited to small configuration and text files")
            raw=args.get("content")
            if not isinstance(raw,str) or len(raw)>350000:raise ValueError("Upload too large")
            try:
                content=base64.b64decode(raw,validate=True)
            except (ValueError,binascii.Error):
                raise ValueError("Invalid upload encoding")
            if len(content)>MAX_FILE:raise ValueError("Upload exceeds 256 KiB limit")
            try:
                content.decode("utf-8")
            except UnicodeDecodeError:
                raise ValueError("Only UTF-8 text uploads are accepted")
            if not path.parent.is_dir():raise ValueError("Destination folder not found")
            if path.is_dir():raise ValueError("A folder already uses that name")
            path.write_bytes(content)
            return "Uploaded successfully; saved in next verified backup"
        if kind in ("files-read","files-write","files-delete"):
            relative=args.get("path","")
            path=self._path(relative,write=kind!="files-read")
            if path.suffix.lower() not in TEXT_SUFFIXES:raise ValueError("Only small text files can be edited")
            if kind=="files-read":
                if not path.is_file():raise ValueError("File not found")
                if path.stat().st_size>MAX_FILE:raise ValueError("File too large for live text editor")
                return {"path":relative,"content":path.read_text(encoding="utf-8")}
            if kind=="files-write":
                value=args.get("content")
                if not isinstance(value,str) or len(value.encode())>MAX_FILE:raise ValueError("Content must be UTF-8 text, up to 256 KiB")
                if not path.parent.is_dir():raise ValueError("Destination folder not found")
                if path.is_dir():raise ValueError("Cannot overwrite a folder")
                path.write_text(value,encoding="utf-8")
                return "Saved to runner filesystem; included in next verified backup"
            if not path.is_file():raise ValueError("File not found")
            path.unlink()
            return "File deleted; deletion captured at next backup"
        raise ValueError("Unsupported command")

    def _memory_mb(self):
        try:
            for line in Path(f"/proc/{self.paper_pid}/status").read_text().splitlines():
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1024, 1)
        except (OSError,ValueError,IndexError):
            pass
        return None

    def _cpu_percent(self):
        """Paper CPU use, where 100% means one full logical CPU core."""
        try:
            raw=Path(f"/proc/{self.paper_pid}/stat").read_text(encoding="utf-8")
            tail=raw.rsplit(")",1)[1].split()
            ticks=int(tail[11])+int(tail[12])
            now=time.monotonic()
            previous=self._cpu_sample
            self._cpu_sample=(now,ticks)
            if previous is None or now<=previous[0] or ticks<previous[1]:
                return None
            hz=os.sysconf("SC_CLK_TCK")
            if not isinstance(hz,int) or hz<=0:
                return None
            return round(max(0.0,(ticks-previous[1])*100.0/(hz*(now-previous[0]))),1)
        except (OSError,ValueError,IndexError,TypeError):
            self._cpu_sample=None
            return None

    def _disk_space(self):
        """Runner filesystem capacity, not a claim about persistent backup storage."""
        try:
            usage=shutil.disk_usage(self.data)
            return {"diskFreeMiB":round(usage.free/1048576),
                    "diskTotalMiB":round(usage.total/1048576)}
        except OSError:
            return {"diskFreeMiB":None,"diskTotalMiB":None}

    def _loop(self):
        while not self.restart_event.is_set() and not self.shutdown_event.is_set():
            now=time.monotonic()
            with self.lock:
                players=sorted(self.players)
                logs=list(self.log_lines)[-60:]
                empty_since=self.observed.get("empty_since")
                empty_seconds=max(0,int(now-empty_since)) if not players and empty_since is not None else 0
                idle_remaining=max(0,3600-empty_seconds) if not players else 3600
            uptime=max(0,int(now-self.started))
            status={"ready":self.ready.is_set(),"players":players,"logs":logs,
                    "uptime":uptime,"restartIn":max(0,19800-uptime),
                    "idleRestartIn":idle_remaining,"emptyFor":empty_seconds,
                    "memoryMiB":self._memory_mb(),"memoryLimitMiB":8192,
                    "cpuPercent":self._cpu_percent(),**self._disk_space(),
                    **(self.metrics.snapshot() if self.metrics is not None else {"tps":None,"mspt":None}),
                    "startupTimings":dict(self.startup_timings),
                    "phase":self.lifecycle_phase if self.lifecycle_phase!="starting" else ("running" if self.ready.is_set() else "starting")}
            if status["ready"]:
                self.performance_history.record({
                    "cpu":status.get("cpuPercent"),
                    "memory":status.get("memoryMiB"),
                    "diskFree":status.get("diskFreeMiB"),
                    "tps":status.get("tps"),
                    "mspt":status.get("mspt"),
                    "players":len(players),
                })
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
            except urllib.error.HTTPError as exc:
                self._failures += 1
                status = exc.code
                if status == 401:
                    reason = "401 Unauthorized: BRIDGE_TOKEN in Cloudflare must exactly match CLOUDFLARE_BRIDGE_TOKEN in GitHub Actions"
                elif status == 403:
                    reason = "403 Forbidden: check Cloudflare Access or firewall rules blocking /api/bridge"
                elif status == 404:
                    reason = "404 Not Found: CLOUDFLARE_CONTROL_URL must be the deployed Worker URL (without /api/bridge)"
                elif status == 400:
                    # Do not print arbitrary response bodies; Workers can
                    # include implementation details in error responses.
                    # These are the only recognized, non-sensitive messages.
                    diagnostic = ""
                    try:
                        body = json.loads(exc.read(2048).decode("utf-8"))
                        diagnostic = body.get("error", "") if isinstance(body, dict) else ""
                    except (ValueError, UnicodeDecodeError, OSError):
                        pass
                    if diagnostic == "Missing runner session":
                        reason = "400 Invalid session: check GitHub Actions GITHUB_RUN_ID"
                    elif diagnostic == "Invalid heartbeat JSON":
                        reason = "400 Malformed heartbeat JSON sent by runner"
                    else:
                        reason = "400 Worker rejected heartbeat: inspect Cloudflare Worker logs and deploy current Worker code"
                elif status == 503:
                    reason = "503 Unavailable: Cloudflare Worker has no BRIDGE_TOKEN secret configured"
                elif status == 502:
                    reason = "502 Worker bridge storage error: inspect Cloudflare Worker logs and MC_BRIDGE binding"
                elif status >= 500:
                    reason = f"{status} Worker error: verify Cloudflare deployment and Durable Object binding"
                else:
                    reason = f"HTTP {status}: bridge request rejected"
                # Print only status and a fixed explanation. Never log request headers,
                # secret values or arbitrary HTML error bodies.
                if reason != self._last_failure or self._failures in (1, 5, 12) or self._failures % 60 == 0:
                    print("Cloudflare bridge connection failed:", reason, flush=True)
                self._last_failure = reason
            except (urllib.error.URLError,TimeoutError,OSError,ValueError) as exc:
                self._failures += 1
                reason = type(exc).__name__ + ": connection or response problem"
                if reason != self._last_failure or self._failures in (1, 5, 12) or self._failures % 60 == 0:
                    print("Cloudflare bridge connection failed:", reason,flush=True)
                self._last_failure = reason
            else:
                if self._failures:
                    print("Cloudflare bridge reconnected successfully",flush=True)
                self._failures = 0
                self._last_failure = ""
            # Healthy live console should refresh quickly; errors back off so we
            # do not overload Cloudflare or fill the runner logs.
            # Preserve the 5-second dashboard refresh and live controls while
            # keeping total Durable Object requests under the free 100k/day
            # request quota (a 1-second 24/7 heartbeat alone uses 86,400).
            # Once a Worker is upgraded or the daily quota resets, reconnect
            # promptly: the UI regards telemetry older than 45 s as offline.
            # Retry at most every 15 s on failure; never pound the API.
            time.sleep(2 if self._failures == 0 else min(15, 5 * 2 ** min(self._failures // 5, 3)))
