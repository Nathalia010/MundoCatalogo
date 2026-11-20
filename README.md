# Mundo Catálogo

Página para consultar catálogos en PDF como libros digitales. Abre cada portada y pasa las hojas con los botones, las flechas del teclado o un gesto horizontal. Los catálogos verticales muestran dos páginas juntas cuando hay espacio. Los siguientes catálogos aparecen al desplazarse hacia abajo.

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

## Guardar los catálogos en Cloudflare R2

1. En Cloudflare, crea el bucket privado `mundo-catalogo` con clase **Standard**. Crea una clave **Object Read & Write** limitada a ese bucket. El sitio accede a R2 desde el servidor. [Configuración de R2 para S3](https://developers.cloudflare.com/r2/get-started/s3/)
2. Completa las cuatro variables de R2 en `.env.r2`. Usa el **S3 API endpoint** para `R2_ENDPOINT`, el nombre del bucket para `R2_BUCKET` y los valores **Access Key ID** y **Secret Access Key** para las otras dos variables. Mantén el archivo fuera de Git.
3. Antes de activar R2 en Render, importa el respaldo. El comando usa `data/r2-backup/index.json` por defecto. También puedes pasar la ruta a otro respaldo o al `catalogos.json` de una instalación local.

   ```powershell
   npm run migrate:r2
   ```

4. Cuando la migración confirme todos los PDF, agrega las mismas cuatro variables en **Environment** del servicio MundoCatalogo en Render y elige **Save only**. Despliega esta versión del código y comprueba que el enlace público muestre los catálogos en el orden esperado. [Variables de entorno en Render](https://render.com/docs/configure-environment-variables)

Con R2 configurado, los archivos locales se usan como espacio temporal. Los PDF, las portadas y el orden se guardan en el bucket. R2 Standard incluye una cuota mensual gratuita. Cloudflare puede cobrar por uso que exceda esa cuota. [Precios de R2](https://developers.cloudflare.com/r2/pricing/)
