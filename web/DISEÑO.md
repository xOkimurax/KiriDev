# Kiri Hub · sistema visual

Panel de operaciones. La información y las acciones aparecen donde se usan; los estados llevan texto y un punto de color.

## Base

- **Tipografía:** DM Sans para interfaz y DM Mono para teléfonos, fechas, identificadores y texto Markdown. Escala: 12 / 13 / 14 / 16 / 20 / 28 px. Títulos con interletrado negativo.
- **Color:** neutros fríos (`#f6f7f5`, `#fff`, `#17211c`, `#dce2dc`), verde de acción `#23745a`, error `#ad3939`, aviso `#946117`. Modo oscuro con superficies `#151b18` / `#1c2420` y contraste ajustado. `data-theme` sigue el sistema o la elección guardada.
- **Espaciado:** grilla de 4 px; separación común 8 / 12 / 16 / 24 / 32. Radios 4 / 6 / 8 px. Bordes de 1 px; sombras solo para menú, drawer y toast. Iconos SVG de 1.5 px. Transiciones de estado de 150 ms; movimiento desactivado si el sistema lo pide.
- **CSS:** variables en `styles.css` para superficies, texto, estados, bordes, radios y capas. El layout pasa de sidebar a barra superior y navegación inferior; la bandeja apila lista e hilo bajo 700 px.

## Componentes

- **Button, Icon, Badge, Card, PageHead, Empty, Skeleton:** controles y estados comunes. `Badge` combina punto y nombre, nunca color solo.
- **Combo:** selector con listbox, búsqueda para listas largas, descripciones, flechas, Inicio/Fin, Enter y Escape. Para dos opciones se usa `Segmented`; para booleanos `Switch`.
- **InlineConfirm:** acción reversible en el lugar del botón, con explicación y Sí/No. **Drawer:** edición lateral en escritorio y hoja inferior en celular; Escape y foco contenido. **Toast:** resultado breve.
- **Bandeja:** lista por actividad con filtros; hilo con fecha y contenido interpretado por `components/message.js`; detalle del contacto colapsable, tareas y acciones. El polling conserva selección y posición de lectura. Los divisores aceptan arrastre o flechas.

## Uso

Texto breve en español rioplatense. Los viewers pueden leer y cambiar su propia contraseña; las demás acciones de edición se ocultan o deshabilitan. Los estados de carga, vacío y error ofrecen contexto y reintento. Una tarea terminada muestra resultado y nombres de archivo; la API de tareas no entrega URL de descarga, por eso esos nombres son informativos. Las descargas de la sesión de prueba usan `attachment.path` cuando está presente.
