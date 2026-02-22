# Elnevezési Konvenciók & Kódstílus

Ez a projekt a **Swift API Design Guidelines** által inspirált elnevezési konvenciókat követi, JavaScript/React fejlesztésre adaptálva. Az elsődleges cél a **Világosság a használat helyén** (Clarity at the point of use).

> Referencia: [Swift API Design Guidelines](https://www.swift.org/documentation/api-design-guidelines/)

## 1. Alapelvek

### Világosság > Rövidség
- A kódot sokkal gyakrabban olvassák, mint írják.
- A világosság a használat helyén a legfontosabb cél.
- Kerüld a rövidítéseket, kivéve ha szabványosak (pl. `min`, `max`). Légy bőbeszédű, ha az növeli a világosságot.

**Rossz:**
```javascript
const doc = app.activeDoc;
const res = await api.get(id);
```

**Jó:**
```javascript
const activeDocument = app.activeDocument;
const article = await api.fetchArticle(articleId);
```

### Kontextus-tudatosság
- Hagyd el a felesleges szavakat. Ha a kontextus már sugallja a típust vagy szerepet, ne ismételd meg.

**Rossz:**
```javascript
allViews.removeElement(cancelButton); // "Element" felesleges
```

**Jó:**
```javascript
allViews.remove(cancelButton);
```

---

## 2. Elnevezés

### Boolean Tulajdonságok
- A boolean változóknak és tulajdonságoknak állításként kell olvasódniuk.
- Használj `is`, `has`, `can`, `should` prefixeket.

**Rossz:**
```javascript
const valid = true;
const mount = useRef(true);
```

**Jó:**
```javascript
const isValid = true;
const isMountedRef = useRef(true);
const hasUnsavedChanges = false;
```

### Függvények & Metódusok
1.  **Akciók (Mellékhatással):** Felszólító igéket használj.
    *   `print(x)`, `sort()`, `append(y)`
    *   `fetchUser()`, `updateArticle()`, `deleteRow()`

2.  **Transzformációk (Mellékhatás nélkül):** Főnévi kifejezéseket vagy múlt idejű melléknévi igeneveket használj.
    *   `x.distance(to: y)`
    *   `sortedList` (nem `sortList`)
    *   `getFormattedDate()`

3.  **Aszinkron Akciók:**
    *   `fetch` — adatlekéréshez (hálózat/adatbázis).
    *   `load` — memóriába töltéshez.
    *   `sync` — szinkronizációs feladatokhoz.

**Példák:**
```javascript
// Adatlekérés
const fetchArticle = async (id) => { ... }

// Validáció & Szinkronizáció
const validateAndSync = async (doc) => { ... }

// Háttérbeli Ellenőrzés
const verifyDocumentInBackground = async (doc) => { ... }
```

### Protokoll / Delegált Minta (Callback-ek)
- A függvényeket aszerint nevezd el, *mi történt* vagy *mi fog történni*.
- Használj `did`, `will`, `should` prefixeket az eseménykezelőkhöz.

**Példák:**
```javascript
const onDidFinishLoading = () => { ... }
const onWillSave = () => { ... }
```

---

## 3. Általános Konvenciók

### Kis- és Nagybetűk
- **UpperCamelCase** típusokhoz, osztályokhoz, komponensekhez (React).
    *   `ArticleProperties`, `DatabaseIntegrityValidator`
- **lowerCamelCase** függvényekhez, metódusokhoz, változókhoz, konstansokhoz.
    *   `fetchArticle`, `isValid`, `maxRetryCount`

### Factory Metódusok
- A factory metódusok nevét `make`-kel kezdd.
    *   `makeIterator()`, `makeWidget()`

---

## 4. React Specifikus

### Komponens Props
- A prop-okat a céljuk szerint nevezd el, ne az implementáció szerint.
- Kerüld az implementációs részleteket a prop nevekben.

**Rossz:**
```javascript
<Button onLeftClick={handleClick} />
```

**Jó:**
```javascript
<Button onClick={handleSubmit} />
```

### Egyedi Hook-ok
- Mindig `use`-zal kezdd.
- Légy leíró azzal kapcsolatban, mit *csinál* vagy *biztosít* a hook.
    *   `useArticleData`, `useWindowSize`
