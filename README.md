# Mundo Catálogo

Página para consultar catálogos en PDF. Cada catálogo empieza en la primera página y tiene sus propios controles. Los siguientes catálogos aparecen al desplazarse hacia abajo.

## Ejecutar en Windows

Con Node.js 24 o posterior, ejecuta en PowerShell desde esta carpeta:

```powershell
npm ci
npm start
```

Abre [Mundo Catálogo](http://127.0.0.1:3000). Usa **Iniciar sesión** con el usuario `AdminTenshi` y la contraseña configurada. En el panel puedes abrir los PDF, agregar archivos de hasta 100 MB o reemplazarlos. Para cambiar el orden público, arrastra un catálogo desde los puntos junto a su nombre o pulsa los puntos y elige una posición.

## Configurar o cambiar el acceso

Si ya tienes el archivo `.env` local, `npm start` lo carga automáticamente. Para configurar una copia nueva, copia `.env.example` como `.env` y genera el valor de `ADMIN_PASSWORD_HASH` desde PowerShell:

```powershell
$catalogPassword = Read-Host 'Contraseña de administración' -AsSecureString
try {
    [System.Net.NetworkCredential]::new('', $catalogPassword).Password |
        node -e "const c = require('node:crypto'); let p = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => p += chunk); process.stdin.on('end', () => { const s = c.randomBytes(16).toString('hex'); console.log(s + ':' + c.scryptSync(p.replace(/\r?\n$/, ''), s, 64).toString('hex')); });"
} finally {
    $catalogPassword.Dispose()
}
```

Pega el resultado en `ADMIN_PASSWORD_HASH` y reinicia el servidor. Guarda una copia de la carpeta `data/` para respaldar los PDF y su orden. Para publicar, usa un servidor Node.js con almacenamiento persistente y HTTPS, configura `DATA_DIR` y activa `SECURE_COOKIE=1`. Usa una contraseña nueva para el acceso público.
