#!/usr/bin/env python3
"""
Servidor HTTP Estático + API REST de Gestión de Carta + WebSocket RFC 6455 Nativo en Python 3.
Réplica 100% compatible de `server.js`:
- GET  /api/menu         -> Devuelve data/menu-data.json
- POST /api/menu         -> Valida, crea backup data/menu-data.backup.json y sobrescribe data/menu-data.json
- POST /api/upload-model -> Guarda archivos binarios .glb (Base64 JSON, Multipart o Binario) en assets/models/
- WS   /ws               -> Comunicación en tiempo real cliente <-> mesero
"""

import asyncio
import base64
import hashlib
import json
import mimetypes
import os
import re
import shutil
import socket
import struct
from urllib.parse import parse_qs, unquote, urlparse

PORT = int(os.environ.get("PORT", "8080"))
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
MENU_FILE_PATH = os.path.join(ROOT_DIR, "data", "menu-data.json")
MENU_BACKUP_PATH = os.path.join(ROOT_DIR, "data", "menu-data.backup.json")
MODELS_DIR_PATH = os.path.join(ROOT_DIR, "assets", "models")
TENANTS_DATA_DIR = os.path.join(ROOT_DIR, "data", "tenants")
TENANTS_ASSETS_DIR = os.path.join(ROOT_DIR, "assets", "tenants")
DEFAULT_TENANT = "demo"
WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def sanitize_tenant_id(raw):
    clean = re.sub(r"[^a-z0-9_-]", "", str(raw or DEFAULT_TENANT).strip().lower())
    return clean or DEFAULT_TENANT


def get_tenant_paths(raw_tenant):
    tenant = sanitize_tenant_id(raw_tenant)
    data_dir = os.path.join(TENANTS_DATA_DIR, tenant)
    menu_path = os.path.join(data_dir, "menu-data.json")
    backup_path = os.path.join(data_dir, "menu-data.backup.json")
    config_path = os.path.join(data_dir, "config.json")
    models_dir = os.path.join(TENANTS_ASSETS_DIR, tenant, "models")

    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(models_dir, exist_ok=True)

    if not os.path.isfile(menu_path):
        demo_menu = os.path.join(TENANTS_DATA_DIR, DEFAULT_TENANT, "menu-data.json")
        src_menu = demo_menu if os.path.isfile(demo_menu) else MENU_FILE_PATH
        if os.path.isfile(src_menu):
            shutil.copyfile(src_menu, menu_path)

    if not os.path.isfile(config_path):
        default_cfg = {
            "tenant": tenant,
            "nombre": "TechaPY · Casa de Autor" if tenant == "demo" else f"TechaPY · {tenant.upper()}",
            "ciudad": "Asunción, Paraguay",
            "moneda": "Gs.",
            "sectores": [
                {"sector": "Terraza", "mesas": 4, "meseroNombre": "Juan Pérez", "meseroId": "juan"},
                {"sector": "Salón Principal", "mesas": 6, "meseroNombre": "Lucía Gómez", "meseroId": "lucia"},
                {"sector": "Barra", "mesas": 3, "meseroNombre": "Carlos Benítez", "meseroId": "carlos"},
                {"sector": "Patio", "mesas": 4, "meseroNombre": "Mateo Duarte", "meseroId": "mateo"},
            ],
            "credenciales": {"usuario": f"admin_{tenant}", "pinAcceso": "1234"},
        }
        with open(config_path, "w", encoding="utf-8") as cf:
            json.dump(default_cfg, cf, ensure_ascii=False, indent=2)

    return {
        "tenant": tenant,
        "data_dir": data_dir,
        "menu_path": menu_path,
        "backup_path": backup_path,
        "config_path": config_path,
        "models_dir": models_dir,
    }

mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("model/gltf+json", ".gltf")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")

clients = {}
active_orders = []


def get_local_lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if ip and not ip.startswith("127."):
                return ip
    except Exception:
        pass
    try:
        import subprocess
        out = subprocess.check_output(["hostname", "-I"], text=True, timeout=2).strip()
        if out:
            first_ip = out.split()[0]
            if first_ip:
                return first_ip
    except Exception:
        pass
    return "127.0.0.1"


def sanitize_glb_filename(raw_name):
    base = os.path.basename(str(raw_name or "modelo.glb")).strip()
    clean = re.sub(r"[^a-zA-Z0-9._-]", "-", base)
    clean = re.sub(r"-+", "-", clean)
    return clean if clean.lower().endswith(".glb") else f"{clean}.glb"


def validate_menu_json(data):
    if not isinstance(data, dict) or not isinstance(data.get("platos"), list):
        return 'El JSON debe incluir un arreglo "platos".'
    for idx, p in enumerate(data["platos"]):
        if not isinstance(p, dict):
            return f"El plato en la posición {idx + 1} no es un objeto válido."
        if not str(p.get("id", "")).strip():
            return f'El plato en la posición {idx + 1} requiere un campo "id".'
        if not str(p.get("nombre", "")).strip():
            return f'El plato "{p.get("id")}" requiere un campo "nombre".'
        if not str(p.get("category", "")).strip():
            return f'El plato "{p.get("nombre")}" requiere un campo "category".'
        try:
            price = float(p.get("precio"))
            if price < 0:
                return f'El plato "{p.get("nombre")}" requiere un "precio" >= 0.'
        except Exception:
            return f'El plato "{p.get("nombre")}" requiere un "precio" numérico válido.'
    return None


def parse_multipart_glb(body_bytes, content_type_header):
    m = re.search(r'boundary=(?:"([^"]+)"|([^;]+))', content_type_header or "", re.I)
    if not m:
        raise ValueError("Falta boundary en multipart/form-data")
    boundary = ("--" + (m.group(1) or m.group(2)).strip()).encode("utf-8")
    parts = body_bytes.split(boundary)
    for part in parts:
        if b"\r\n\r\n" not in part:
            continue
        header_block, content = part.split(b"\r\n\r\n", 1)
        header_text = header_block.decode("utf-8", errors="ignore")
        fn_match = re.search(r'filename="([^"]+)"', header_text, re.I)
        if fn_match:
            if content.endswith(b"\r\n"):
                content = content[:-2]
            return fn_match.group(1), content
    raise ValueError("No se encontró archivo adjunto en multipart/form-data")


def encode_ws_text_frame(data_obj):
    text = data_obj if isinstance(data_obj, str) else json.dumps(data_obj, ensure_ascii=False)
    payload = text.encode("utf-8")
    length = len(payload)

    if length < 126:
        header = struct.pack("!BB", 0x81, length)
    elif length < 65536:
        header = struct.pack("!BBH", 0x81, 126, length)
    else:
        header = struct.pack("!BBQ", 0x81, 127, length)

    return header + payload


async def send_ws_json(writer, data_obj):
    if writer.is_closing():
        return
    try:
        frame = encode_ws_text_frame(data_obj)
        writer.write(frame)
        await writer.drain()
    except Exception:
        pass


async def handle_ws_message(writer, msg):
    if not isinstance(msg, dict):
        return

    meta = clients.get(writer, {"role": "unknown"})
    msg_type = msg.get("type") or msg.get("eventType")

    if msg_type == "REGISTER_WAITER":
        meta["role"] = "mesero"
        meta["tenant"] = sanitize_tenant_id(msg.get("tenant") or meta.get("tenant"))
        meta["waiterId"] = str(msg.get("id") or "juan").lower()
        meta["sector"] = str(msg.get("sector") or "Terraza")
        meta["tenantSectorKey"] = f"{meta['tenant']}:{meta['sector'].lower()}"
        clients[writer] = meta
        print(f"[WS] 🛎️  Mesero conectado [{meta['tenant']}]: {meta['waiterId'].upper()} (Sector: {meta['sector']})")
        tenant_orders = [o for o in active_orders if sanitize_tenant_id(o.get("tenant")) == meta["tenant"]]
        await send_ws_json(
            writer,
            {
                "type": "INITIAL_ORDERS",
                "eventType": "INITIAL_ORDERS",
                "tenant": meta["tenant"],
                "orders": tenant_orders,
            },
        )
        return

    if msg_type == "REGISTER_CLIENT":
        meta["role"] = "cliente"
        meta["tenant"] = sanitize_tenant_id(msg.get("tenant") or meta.get("tenant"))
        meta["mesa"] = str(msg.get("mesa") or "1")
        meta["sector"] = str(msg.get("sector") or "Terraza")
        meta["waiterId"] = str(msg.get("mesero_id") or "juan").lower()
        meta["tenantSectorKey"] = f"{meta['tenant']}:{meta['sector'].lower()}"
        clients[writer] = meta
        print(f"[WS] 📱 Cliente conectado [{meta['tenant']}]: Mesa {meta['mesa']} ({meta['sector']})")
        table_orders = [
            o
            for o in active_orders
            if sanitize_tenant_id(o.get("tenant")) == meta["tenant"]
            and str(o.get("mesa")) == meta["mesa"]
            and str(o.get("sector", "")).lower() == meta["sector"].lower()
        ]
        await send_ws_json(
            writer,
            {
                "type": "CLIENT_SYNC",
                "eventType": "CLIENT_SYNC",
                "tenant": meta["tenant"],
                "orders": table_orders,
            },
        )
        return

    if msg_type in ("NEW_ORDER", "NUEVA_COMANDA", "COMANDA", "LLAMADO_MESERO"):
        order = msg.get("order") or msg
        if not isinstance(order, dict) or not order.get("id"):
            return

        order["tenant"] = sanitize_tenant_id(order.get("tenant") or msg.get("tenant") or meta.get("tenant"))
        order_key = f"{order['tenant']}:{str(order.get('sector') or 'Terraza').lower()}"

        existing_idx = next(
            (i for i, o in enumerate(active_orders) if o.get("id") == order.get("id")),
            -1,
        )
        if existing_idx == -1:
            active_orders.insert(0, order)
            if len(active_orders) > 300:
                active_orders.pop()
        else:
            active_orders[existing_idx] = order

        print(
            f"[WS] 🚀 {order.get('tipo', 'COMANDA')} [{order.get('id')}] ({order_key}) — Mesa {order.get('mesa')}"
        )

        for client_writer, info in list(clients.items()):
            if info.get("role") == "mesero" and sanitize_tenant_id(info.get("tenant")) == order["tenant"]:
                info_key = f"{sanitize_tenant_id(info.get('tenant'))}:{str(info.get('sector', '')).lower()}"
                sector_match = (
                    not info.get("sector")
                    or info_key == order_key
                    or info.get("waiterId", "").lower() == str(order.get("mesero_id", "")).lower()
                )
                await send_ws_json(
                    client_writer,
                    {
                        "type": "NUEVA_COMANDA",
                        "eventType": "NUEVA_COMANDA",
                        "tenant": order["tenant"],
                        "tenantSector": order_key,
                        "sectorMatch": sector_match,
                        "order": order,
                    },
                )

        await send_ws_json(
            writer,
            {
                "type": "ORDER_ACK",
                "eventType": "COMANDA_CONFIRMADA",
                "tenant": order["tenant"],
                "order": order,
            },
        )
        return

    if msg_type in ("UPDATE_ORDER_STATUS", "ESTADO_ACTUALIZADO"):
        incoming_order = msg.get("order")
        order_id = msg.get("orderId") or (incoming_order.get("id") if isinstance(incoming_order, dict) else None)
        new_status = msg.get("estado") or (incoming_order.get("estado") if isinstance(incoming_order, dict) else None)
        if not order_id:
            return

        target_order = next((o for o in active_orders if o.get("id") == order_id), None)
        if target_order and new_status:
            target_order["estado"] = new_status
        elif isinstance(incoming_order, dict):
            incoming_order["tenant"] = sanitize_tenant_id(
                incoming_order.get("tenant") or msg.get("tenant") or meta.get("tenant")
            )
            target_order = incoming_order
            active_orders.insert(0, target_order)

        if not target_order:
            return
        target_tenant = sanitize_tenant_id(target_order.get("tenant"))

        print(
            f"[WS] ✅ Estado actualizado [{target_tenant}] [{target_order.get('id')}] Mesa {target_order.get('mesa')} -> {target_order.get('estado')}"
        )

        for client_writer, info in list(clients.items()):
            if sanitize_tenant_id(info.get("tenant")) != target_tenant:
                continue
            if info.get("role") == "mesero":
                await send_ws_json(
                    client_writer,
                    {
                        "type": "ESTADO_ACTUALIZADO",
                        "eventType": "ESTADO_ACTUALIZADO",
                        "tenant": target_tenant,
                        "order": target_order,
                    },
                )
            elif (
                info.get("role") == "cliente"
                and str(info.get("mesa")) == str(target_order.get("mesa"))
                and str(info.get("sector", "")).lower() == str(target_order.get("sector", "")).lower()
            ):
                await send_ws_json(
                    client_writer,
                    {
                        "type": "ESTADO_ACTUALIZADO",
                        "eventType": "ESTADO_ACTUALIZADO",
                        "tenant": target_tenant,
                        "order": target_order,
                    },
                )
        return

    if msg_type in ("CLEAR_SHIFT", "TURNO_ACTUALIZADO"):
        target_tenant = sanitize_tenant_id(msg.get("tenant") or meta.get("tenant"))
        only_attended = msg.get("onlyAttended", True)
        if only_attended:
            active_orders[:] = [
                o
                for o in active_orders
                if sanitize_tenant_id(o.get("tenant")) != target_tenant or o.get("estado") != "Atendido"
            ]
        else:
            active_orders[:] = [o for o in active_orders if sanitize_tenant_id(o.get("tenant")) != target_tenant]

        remaining_for_tenant = [o for o in active_orders if sanitize_tenant_id(o.get("tenant")) == target_tenant]
        for client_writer, info in list(clients.items()):
            if info.get("role") == "mesero" and sanitize_tenant_id(info.get("tenant")) == target_tenant:
                await send_ws_json(
                    client_writer,
                    {
                        "type": "TURNO_ACTUALIZADO",
                        "eventType": "TURNO_ACTUALIZADO",
                        "tenant": target_tenant,
                        "orders": remaining_for_tenant,
                    },
                )


async def handle_websocket(reader, writer, key):
    accept_raw = (key + WS_MAGIC_GUID).encode("ascii")
    accept_key = base64.b64encode(hashlib.sha1(accept_raw).digest()).decode("ascii")

    handshake = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept_key}\r\n\r\n"
    )
    writer.write(handshake.encode("ascii"))
    await writer.drain()

    clients[writer] = {"role": "connected"}

    try:
        while True:
            first2 = await reader.readexactly(2)
            b1, b2 = first2[0], first2[1]
            opcode = b1 & 0x0F
            masked = (b2 & 0x80) != 0
            payload_len = b2 & 0x7F

            if payload_len == 126:
                ext = await reader.readexactly(2)
                payload_len = struct.unpack("!H", ext)[0]
            elif payload_len == 127:
                ext = await reader.readexactly(8)
                payload_len = struct.unpack("!Q", ext)[0]

            mask_key = await reader.readexactly(4) if masked else None
            payload = bytearray(await reader.readexactly(payload_len))

            if masked and mask_key:
                for i in range(payload_len):
                    payload[i] ^= mask_key[i % 4]

            if opcode == 0x08:
                break
            elif opcode == 0x09:
                writer.write(bytes([0x8A, len(payload)]) + bytes(payload))
                await writer.drain()
            elif opcode == 0x01:
                try:
                    data = json.loads(payload.decode("utf-8"))
                    await handle_ws_message(writer, data)
                except Exception as e:
                    print("[WS] Error procesando JSON:", e)
    except (asyncio.IncompleteReadError, ConnectionResetError):
        pass
    finally:
        clients.pop(writer, None)
        writer.close()


async def send_http_json(writer, status_code, status_text, payload_obj):
    body = json.dumps(payload_obj, ensure_ascii=False).encode("utf-8")
    headers = (
        f"HTTP/1.1 {status_code} {status_text}\r\n"
        "Content-Type: application/json; charset=utf-8\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Cache-Control: no-store\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type, X-Filename\r\n\r\n"
    ).encode("utf-8")
    writer.write(headers + body)
    await writer.drain()
    writer.close()


async def handle_client(reader, writer):
    try:
        request_line = await reader.readline()
        if not request_line:
            writer.close()
            return

        parts = request_line.decode("utf-8", errors="ignore").strip().split(" ")
        if len(parts) < 2:
            writer.close()
            return

        method, raw_target = parts[0].upper(), parts[1]
        headers = {}
        while True:
            line = await reader.readline()
            if not line or line in (b"\r\n", b"\n"):
                break
            decoded = line.decode("utf-8", errors="ignore").strip()
            if ":" in decoded:
                k, v = decoded.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        if method == "OPTIONS":
            resp = (
                "HTTP/1.1 204 No Content\r\n"
                "Access-Control-Allow-Origin: *\r\n"
                "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                "Access-Control-Allow-Headers: Content-Type, X-Filename\r\n\r\n"
            ).encode("utf-8")
            writer.write(resp)
            await writer.drain()
            writer.close()
            return

        if headers.get("upgrade", "").lower() == "websocket" and "sec-websocket-key" in headers:
            await handle_websocket(reader, writer, headers["sec-websocket-key"])
            return

        parsed_url = urlparse(raw_target)
        parsed_path = unquote(parsed_url.path)
        query_params = parse_qs(parsed_url.query)

        # 1. GET /api/server-info
        if parsed_path == "/api/server-info" and method == "GET":
            lan_ip = get_local_lan_ip()
            lan_base_url = f"http://{lan_ip}:{PORT}"
            public_url = None
            tunnel_info_path = os.path.join(ROOT_DIR, "data", "tunnel-info.json")
            if os.path.isfile(tunnel_info_path):
                try:
                    with open(tunnel_info_path, "r", encoding="utf-8") as tf:
                        tdata = json.load(tf)
                        if isinstance(tdata, dict) and tdata.get("publicUrl"):
                            public_url = tdata["publicUrl"].rstrip("/")
                except Exception:
                    pass
            effective_base = public_url or lan_base_url
            effective_ws = (
                f"wss://{public_url.replace('https://', '').replace('http://', '')}/ws"
                if public_url
                else f"ws://{lan_ip}:{PORT}/ws"
            )
            await send_http_json(
                writer,
                200,
                "OK",
                {
                    "lanIp": lan_ip,
                    "port": PORT,
                    "lanBaseUrl": lan_base_url,
                    "publicUrl": public_url,
                    "baseUrl": effective_base,
                    "wsUrl": effective_ws,
                    "activeOrdersCount": len(active_orders),
                },
            )
            return

        # Resolver rutas Multi-Tenant: /api/:tenant/menu, /api/:tenant/upload-model, /api/:tenant/config
        tenant_match = re.match(r"^/api/([a-zA-Z0-9_-]+)/(menu|upload-model|config)$", parsed_path)
        route_tenant = (
            sanitize_tenant_id(tenant_match.group(1))
            if tenant_match
            else sanitize_tenant_id((query_params.get("tenant") or [DEFAULT_TENANT])[0])
        )
        route_action = tenant_match.group(2) if tenant_match else None

        # 1b. GET /api/:tenant/config
        if (route_action == "config" or parsed_path == "/api/config") and method == "GET":
            tpaths = get_tenant_paths(route_tenant)
            with open(tpaths["config_path"], "rb") as cf:
                content = cf.read()
            resp = (
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: application/json; charset=utf-8\r\n"
                f"Content-Length: {len(content)}\r\n"
                "Cache-Control: no-store\r\n"
                "Access-Control-Allow-Origin: *\r\n\r\n"
            ).encode("utf-8") + content
            writer.write(resp)
            await writer.drain()
            writer.close()
            return

        # 2. GET /api/:tenant/menu o GET /api/menu
        if (route_action == "menu" or parsed_path == "/api/menu") and method == "GET":
            tpaths = get_tenant_paths(route_tenant)
            if not os.path.isfile(tpaths["menu_path"]):
                await send_http_json(writer, 404, "Not Found", {"ok": False, "error": "No existe menu-data.json"})
                return
            with open(tpaths["menu_path"], "rb") as f:
                content = f.read()
            resp = (
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: application/json; charset=utf-8\r\n"
                f"Content-Length: {len(content)}\r\n"
                "Cache-Control: no-store\r\n"
                "Access-Control-Allow-Origin: *\r\n\r\n"
            ).encode("utf-8") + content
            writer.write(resp)
            await writer.drain()
            writer.close()
            return

        # Leer cuerpo si es POST
        content_len = int(headers.get("content-length", "0") or "0")
        body_bytes = await reader.readexactly(content_len) if content_len > 0 else b""

        # POST /api/:tenant/config
        if (route_action == "config" or parsed_path == "/api/config") and method == "POST":
            try:
                tpaths = get_tenant_paths(route_tenant)
                parsed = json.loads(body_bytes.decode("utf-8"))
                parsed["tenant"] = tpaths["tenant"]
                with open(tpaths["config_path"], "w", encoding="utf-8") as cf:
                    json.dump(parsed, cf, ensure_ascii=False, indent=2)
                await send_http_json(writer, 200, "OK", {"ok": True, "tenant": tpaths["tenant"], "config": parsed})
            except Exception as e:
                await send_http_json(writer, 400, "Bad Request", {"ok": False, "error": str(e)})
            return

        # 3. POST /api/:tenant/menu o POST /api/menu
        if (route_action == "menu" or parsed_path == "/api/menu") and method == "POST":
            try:
                tpaths = get_tenant_paths(route_tenant)
                parsed = json.loads(body_bytes.decode("utf-8"))
                err_msg = validate_menu_json(parsed)
                if err_msg:
                    await send_http_json(writer, 400, "Bad Request", {"ok": False, "error": err_msg})
                    return

                if os.path.isfile(tpaths["menu_path"]):
                    shutil.copyfile(tpaths["menu_path"], tpaths["backup_path"])

                formatted = json.dumps(parsed, ensure_ascii=False, indent=2) + "\n"
                with open(tpaths["menu_path"], "w", encoding="utf-8") as f:
                    f.write(formatted)
                if tpaths["tenant"] == DEFAULT_TENANT:
                    with open(MENU_FILE_PATH, "w", encoding="utf-8") as f:
                        f.write(formatted)

                print(
                    f"[API] 💾 Carta actualizada [{tpaths['tenant']}] ({len(parsed['platos'])} platos)"
                )

                for client_writer, info in list(clients.items()):
                    if sanitize_tenant_id(info.get("tenant")) == tpaths["tenant"]:
                        await send_ws_json(
                            client_writer,
                            {
                                "type": "MENU_UPDATED",
                                "eventType": "MENU_UPDATED",
                                "tenant": tpaths["tenant"],
                                "platosCount": len(parsed["platos"]),
                            },
                        )

                await send_http_json(
                    writer,
                    200,
                    "OK",
                    {
                        "ok": True,
                        "tenant": tpaths["tenant"],
                        "message": "Carta guardada correctamente y copia de seguridad creada",
                        "backupPath": f"data/tenants/{tpaths['tenant']}/menu-data.backup.json",
                        "platosCount": len(parsed["platos"]),
                    },
                )
            except Exception as e:
                await send_http_json(writer, 400, "Bad Request", {"ok": False, "error": str(e)})
            return

        # 4. POST /api/:tenant/upload-model o POST /api/upload-model
        if (route_action == "upload-model" or parsed_path == "/api/upload-model") and method == "POST":
            try:
                tpaths = get_tenant_paths(route_tenant)
                os.makedirs(tpaths["models_dir"], exist_ok=True)
                ctype = headers.get("content-type", "").lower()

                if "application/json" in ctype:
                    payload = json.loads(body_bytes.decode("utf-8"))
                    filename = sanitize_glb_filename(payload.get("filename") or "modelo.glb")
                    raw_b64 = re.sub(r"^data:[^;]+;base64,", "", str(payload.get("dataBase64") or payload.get("data") or ""))
                    file_bytes = base64.b64decode(raw_b64)
                elif "multipart/form-data" in ctype:
                    raw_fn, file_bytes = parse_multipart_glb(body_bytes, headers.get("content-type", ""))
                    filename = sanitize_glb_filename(raw_fn)
                else:
                    raw_fn = headers.get("x-filename") or (query_params.get("filename", ["modelo.glb"])[0])
                    filename = sanitize_glb_filename(raw_fn)
                    file_bytes = body_bytes

                if not file_bytes or len(file_bytes) < 12:
                    await send_http_json(
                        writer, 400, "Bad Request", {"ok": False, "error": "Archivo .glb vacío o inválido"}
                    )
                    return

                disk_path = os.path.join(tpaths["models_dir"], filename)
                with open(disk_path, "wb") as f:
                    f.write(file_bytes)

                rel_path = f"./assets/tenants/{tpaths['tenant']}/models/{filename}"
                print(f"[API] 📦 Modelo 3D guardado [{tpaths['tenant']}]: {rel_path} ({len(file_bytes) / 1024:.1f} KB)")

                await send_http_json(
                    writer,
                    200,
                    "OK",
                    {
                        "ok": True,
                        "tenant": tpaths["tenant"],
                        "filename": filename,
                        "path": rel_path,
                        "sizeBytes": len(file_bytes),
                    },
                )
            except Exception as e:
                await send_http_json(writer, 400, "Bad Request", {"ok": False, "error": str(e)})
            return

        # 5. Archivos estáticos
        if parsed_path == "/":
            parsed_path = "/index.html"

        safe_path = os.path.normpath(os.path.join(ROOT_DIR, parsed_path.lstrip("/")))
        if not safe_path.startswith(ROOT_DIR) or not os.path.isfile(safe_path):
            msg = b"404 Not Found"
            writer.write(
                b"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 13\r\n\r\n" + msg
            )
            await writer.drain()
            writer.close()
            return

        ctype, _ = mimetypes.guess_type(safe_path)
        ctype = ctype or "application/octet-stream"
        with open(safe_path, "rb") as f:
            content = f.read()

        header_bytes = (
            "HTTP/1.1 200 OK\r\n"
            f"Content-Type: {ctype}\r\n"
            f"Content-Length: {len(content)}\r\n"
            "Cache-Control: no-cache\r\n"
            "Access-Control-Allow-Origin: *\r\n\r\n"
        ).encode("utf-8")
        writer.write(header_bytes + content)
        await writer.drain()
        writer.close()
    except Exception:
        writer.close()


async def main():
    lan_ip = get_local_lan_ip()
    server = await asyncio.start_server(handle_client, "0.0.0.0", PORT)
    print("==================================================================")
    print(" 🍜 KUROSHIO 3D & AR — SERVIDOR INTEGRADO HTTP + API + WEBSOCKET")
    print("==================================================================")
    print(f" • Escuchando en:                         0.0.0.0:{PORT}")
    print(f" • Red Local Wi-Fi (Para QR y Celulares): http://{lan_ip}:{PORT}")
    print(f" • Acceso Local en esta máquina:          http://localhost:{PORT}")
    print(f" • Endpoint WebSocket en Tiempo Real:     ws://{lan_ip}:{PORT}/ws")
    print("------------------------------------------------------------------")
    print(f" 📱 Menú 3D Cliente:   http://{lan_ip}:{PORT}/index.html?mesa=4&sector=Terraza&mesero=juan")
    print(f" 🛎️  Panel del Mesero:  http://{lan_ip}:{PORT}/mesero.html?id=juan&sector=Terraza")
    print(f" 📋 Gestión de Carta:  http://{lan_ip}:{PORT}/admin-menu.html")
    print(f" 🖨️  Generador QR:      http://{lan_ip}:{PORT}/admin-qr.html")
    print("==================================================================", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
