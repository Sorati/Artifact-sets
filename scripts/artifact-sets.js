const ARTIFACT_SETS_MODULE_ID = "artifact-sets";
const ARTIFACT_SETS_CONFIG_FLAG = "artifactSet";
const ARTIFACT_SETS_GRANTED_FLAG = "autoGrantedArtifactSet";
const ARTIFACT_SETS_FEATURE_TYPE = "artifactSetFeature";

// Кэш определений наборов.
let artifactSetDefinitions = null;
let artifactSetDefinitionsPromise = null;

// Защита от повторной синхронизации персонажей.
const artifactSetSyncing = new Set();
const artifactSetRerun = new Set();
const artifactSetPending = new Set();

// WeakMap не удерживает закрытые окна редактора в памяти.
const artifactSetEditorObservers = new WeakMap();

// Включи true для подробных диагностических логов.
const ARTIFACT_SETS_DEBUG = false;


/* =========================================================
   ИНИЦИАЛИЗАЦИЯ
========================================================= */

Hooks.once("init", () => {
    CONFIG.DND5E.featureTypes[ARTIFACT_SETS_FEATURE_TYPE] = {
        label: "Особенность набора артефактов"
    };

    console.log("Artifact-sets | Универсальные наборы артефактов загружены.");
});


/* =========================================================
   РЕДАКТОР НАБОРА АРТЕФАКТОВ
========================================================= */

async function artifactSetsRenderArtifactSetEditor(app, html) {
    const item = app.document ?? app.item;

    if (!item || item.type !== "feat") return;

    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;

    const typeSelect = root.querySelector('select[name="system.type.value"]');
    if (!typeSelect || root.querySelector(".artifact-sets-fields")) return;

    const typeGroup = typeSelect.closest(".form-group");
    if (!typeGroup) return;

    const savedConfig = item.getFlag(
        ARTIFACT_SETS_MODULE_ID,
        ARTIFACT_SETS_CONFIG_FLAG
    ) ?? {};

    let requiredItems = Array.isArray(savedConfig.requiredItems)
        ? structuredClone(savedConfig.requiredItems)
        : [];

    let draggedUuid = null;
    let rendering = false;
    let renderAgain = false;

    const section = document.createElement("div");
    section.className = "form-group artifact-sets-fields";

    const label = document.createElement("label");
    label.textContent = "Требуемые предметы";

    const fields = document.createElement("div");
    fields.className = "form-fields";
    fields.style.display = "block";

    const dropZone = document.createElement("div");
    dropZone.className = "artifact-sets-drop-zone";
    dropZone.innerHTML =
        '<i class="fas fa-box-open"></i>' +
        "<span>Перетащи сюда предмет из любого компендиума или с листа предмета</span>";

    const container = document.createElement("div");
    container.className = "artifact-sets-container";

    const header = document.createElement("div");
    header.className = "artifact-sets-header";
    header.textContent = "Требуемые предметы";

    const list = document.createElement("div");
    list.className = "artifact-sets-list";

    container.append(header, list);
    fields.append(dropZone, container);
    section.append(label, fields);
    typeGroup.insertAdjacentElement("afterend", section);

    function isEditing() {
        const form = root.matches("form")
            ? root
            : root.querySelector("form");

        if (
            root.classList.contains("locked") ||
            form?.classList.contains("locked")
        ) {
            return false;
        }

        if (
            root.classList.contains("editable") ||
            form?.classList.contains("editable")
        ) {
            return true;
        }

        return false;
    }

    function updateVisibility() {
        const correctType = typeSelect.value === ARTIFACT_SETS_FEATURE_TYPE;
        const editing = isEditing();

        section.hidden = !correctType;
        dropZone.hidden = !editing;

        container.classList.toggle("is-editing", editing);
        container.classList.toggle("is-viewing", !editing);
    }

    async function saveItems() {
        await item.setFlag(
            ARTIFACT_SETS_MODULE_ID,
            ARTIFACT_SETS_CONFIG_FLAG,
            { requiredItems }
        );

        artifactSetsInvalidateArtifactSetDefinitions();

        // Просим синхронизацию повториться, если она уже выполняется.
        for (const actor of game.actors.contents) {
            if (actor.type !== "character") continue;

            const lockKey = actor.uuid ?? actor.id;

            if (artifactSetSyncing.has(lockKey)) {
                artifactSetRerun.add(lockKey);
            }
        }
    }

    async function moveArtifact(fromUuid, toUuid) {
        if (isEditing() || !fromUuid || !toUuid || fromUuid === toUuid) {
            return;
        }

        const fromIndex = requiredItems.findIndex(x => x.uuid === fromUuid);
        const toIndex = requiredItems.findIndex(x => x.uuid === toUuid);

        if (fromIndex < 0 || toIndex < 0) return;

        [requiredItems[fromIndex], requiredItems[toIndex]] =
            [requiredItems[toIndex], requiredItems[fromIndex]];

        await saveItems();
        await renderList();
    }

    async function renderList() {
        if (rendering) {
            renderAgain = true;
            return;
        }

        rendering = true;

        try {
            do {
                renderAgain = false;
                list.replaceChildren();
                updateVisibility();

                if (!requiredItems.length) {
                    const empty = document.createElement("div");
                    empty.className = "artifact-sets-empty";
                    empty.textContent = "Предметы пока не добавлены.";
                    list.append(empty);
                    continue;
                }

                const TextEditor = foundry.applications.ux.TextEditor.implementation;
                const editing = isEditing();

                for (const artifact of requiredItems) {
                    const entry = document.createElement("div");
                    entry.className = "artifact-sets-entry";
                    entry.dataset.uuid = artifact.uuid;

                    const linkArea = document.createElement("div");
                    linkArea.className = "artifact-sets-link-area";

                    const icon = document.createElement("img");
                    icon.className = "artifact-sets-icon";
                    icon.src = artifact.img || "icons/svg/item-bag.svg";
                    icon.alt = artifact.name;
                    icon.title = artifact.name;
                    icon.draggable = false;

                    const link = document.createElement("span");
                    link.className = "artifact-sets-link";
                    link.innerHTML = await TextEditor.enrichHTML(
                        `@UUID[${artifact.uuid}]{«${artifact.name}»}`,
                        { async: true }
                    );

                    linkArea.append(icon, link);

                    const remove = document.createElement("button");
                    remove.type = "button";
                    remove.className = "artifact-sets-remove";
                    remove.innerHTML = '<i class="fas fa-trash"></i>';
                    remove.title = `Удалить ${artifact.name} из набора`;
                    remove.setAttribute("aria-label", remove.title);
                    remove.hidden = !editing;

                    remove.addEventListener("click", async event => {
                        event.preventDefault();
                        event.stopPropagation();

                        if (!isEditing()) return;

                        requiredItems = requiredItems.filter(
                            x => x.uuid !== artifact.uuid
                        );

                        try {
                            await saveItems();
                            await renderList();
                        } catch (error) {
                            console.error(
                                "Artifact-sets | Ошибка удаления предмета:",
                                error
                            );
                            ui.notifications.error("Не удалось сохранить набор.");
                        }
                    });

                    const reorder = document.createElement("button");
                    reorder.type = "button";
                    reorder.className = "artifact-sets-reorder";
                    reorder.innerHTML = '<i class="fas fa-up-down-left-right"></i>';
                    reorder.title = "Перетащи, чтобы изменить порядок";
                    reorder.setAttribute("aria-label", reorder.title);
                    reorder.draggable = !editing;
                    reorder.hidden = editing;

                    reorder.addEventListener("dragstart", event => {
                        if (isEditing()) {
                            event.preventDefault();
                            return;
                        }

                        draggedUuid = artifact.uuid;
                        entry.classList.add("dragging");

                        event.dataTransfer?.setData("text/plain", artifact.uuid);

                        if (event.dataTransfer) {
                            event.dataTransfer.effectAllowed = "move";
                        }
                    });

                    reorder.addEventListener("dragend", () => {
                        draggedUuid = null;

                        list.querySelectorAll(".dragging, .drag-target").forEach(el => {
                            el.classList.remove("dragging", "drag-target");
                        });
                    });

                    entry.addEventListener("dragover", event => {
                        if (isEditing() || !draggedUuid) return;

                        event.preventDefault();

                        if (event.dataTransfer) {
                            event.dataTransfer.dropEffect = "move";
                        }

                        entry.classList.add("drag-target");
                    });

                    entry.addEventListener("dragleave", event => {
                        if (!entry.contains(event.relatedTarget)) {
                            entry.classList.remove("drag-target");
                        }
                    });

                    entry.addEventListener("drop", async event => {
                        if (isEditing()) return;

                        event.preventDefault();
                        event.stopPropagation();

                        const fromUuid =
                            event.dataTransfer?.getData("text/plain") || draggedUuid;

                        entry.classList.remove("drag-target");

                        try {
                            await moveArtifact(fromUuid, artifact.uuid);
                        } catch (error) {
                            console.error(
                                "Artifact-sets | Ошибка перестановки:",
                                error
                            );
                            ui.notifications.error(
                                "Не удалось изменить порядок предметов."
                            );
                        }

                        draggedUuid = null;
                    });

                    entry.append(linkArea, remove, reorder);
                    list.append(entry);
                }

                updateVisibility();
            } while (renderAgain);
        } finally {
            rendering = false;
        }
    }

        // Приём предметов из компендиумов и с листов предметов.
    dropZone.addEventListener("dragover", event => {
        if (!isEditing()) return;

        event.preventDefault();
        dropZone.classList.add("drag-over");
    });

    dropZone.addEventListener("dragleave", () => {
        dropZone.classList.remove("drag-over");
    });

    dropZone.addEventListener("drop", async event => {
        if (!isEditing()) return;

        event.preventDefault();
        dropZone.classList.remove("drag-over");

        try {
            const raw = event.dataTransfer?.getData("text/plain");

            if (!raw) {
                ui.notifications.warn(
                    "Не удалось прочитать перетаскиваемый предмет."
                );
                return;
            }

            const data = JSON.parse(raw);

            if (data.type !== "Item" || !data.uuid) {
                ui.notifications.warn("Перетащи сюда предмет Foundry.");
                return;
            }

            const droppedItem = await fromUuid(data.uuid);

            if (!droppedItem || droppedItem.documentName !== "Item") {
                ui.notifications.warn("Не удалось найти этот предмет.");
                return;
            }

            if (requiredItems.some(x => x.uuid === droppedItem.uuid)) {
                ui.notifications.info("Этот предмет уже добавлен.");
                return;
            }

            requiredItems.push({
                uuid: droppedItem.uuid,
                name: droppedItem.name,
                img: droppedItem.img
            });

            await saveItems();
            await renderList();
        } catch (error) {
            console.error("Artifact-sets | Ошибка добавления предмета:", error);
            ui.notifications.error("Не удалось добавить предмет.");
        }
    });

    typeSelect.addEventListener("change", () => {
        updateVisibility();
        void renderList();
    });

    // При повторном рендере отключаем предыдущий observer этого окна.
    artifactSetEditorObservers.get(app)?.disconnect();

    const observer = new MutationObserver(() => {
        updateVisibility();
        void renderList();
    });

    observer.observe(root, {
        attributes: true,
        attributeFilter: ["class"]
    });

    const form = root.matches("form") ? root : root.querySelector("form");

    if (form && form !== root) {
        observer.observe(form, {
            attributes: true,
            attributeFilter: ["class"]
        });
    }

    artifactSetEditorObservers.set(app, observer);

    await renderList();
    updateVisibility();
}

Hooks.on("renderItemSheet5e", (app, html) => {
    void artifactSetsRenderArtifactSetEditor(app, html).catch(error => {
        console.error("Artifact-sets | Ошибка редактора набора артефактов:", error);
    });
});


/* =========================================================
   ПОИСК ОПРЕДЕЛЕНИЙ НАБОРОВ
========================================================= */

async function artifactSetsGetArtifactSetDefinitions() {
    if (artifactSetDefinitions !== null) {
        return artifactSetDefinitions;
    }

    if (artifactSetDefinitionsPromise) {
        return artifactSetDefinitionsPromise;
    }

    artifactSetDefinitionsPromise = (async () => {
        const definitionsByUuid = new Map();

        const isDefinition = item => {
            if (
                !item ||
                item.type !== "feat" ||
                item.system.type?.value !== ARTIFACT_SETS_FEATURE_TYPE
            ) {
                return false;
            }

            const requiredItems = item.getFlag(
                ARTIFACT_SETS_MODULE_ID,
                ARTIFACT_SETS_CONFIG_FLAG
            )?.requiredItems;

            return Array.isArray(requiredItems) && requiredItems.length > 0;
        };

        // Особенности, находящиеся непосредственно в мире.
        for (const item of game.items.contents) {
            if (isDefinition(item)) {
                definitionsByUuid.set(item.uuid, item);
            }
        }

        // Проверяем индексы компендиумов и загружаем документы
        // только для потенциальных определений наборов.
        for (const pack of game.packs.contents) {
            if (pack.documentName !== "Item") continue;

            try {
                const index = await pack.getIndex({
                    fields: [
                        "type",
                        "system.type.value",
                        `flags.${ARTIFACT_SETS_MODULE_ID}.${ARTIFACT_SETS_CONFIG_FLAG}`
                    ]
                });

                for (const entry of index) {
                    if (entry.type !== "feat") continue;

                    if (entry.system?.type?.value !== ARTIFACT_SETS_FEATURE_TYPE) {
                        continue;
                    }

                    const config = foundry.utils.getProperty(
                        entry,
                        `flags.${ARTIFACT_SETS_MODULE_ID}.${ARTIFACT_SETS_CONFIG_FLAG}`
                    );

                    if (
                        !Array.isArray(config?.requiredItems) ||
                        config.requiredItems.length === 0
                    ) {
                        continue;
                    }

                    const document = await pack.getDocument(entry._id);

                    if (isDefinition(document)) {
                        definitionsByUuid.set(document.uuid, document);
                    }
                }
            } catch (error) {
                console.warn(
                    `Artifact-sets | Не удалось прочитать компендиум ${pack.collection}:`,
                    error
                );
            }
        }

        artifactSetDefinitions = [...definitionsByUuid.values()];

        if (ARTIFACT_SETS_DEBUG) {
            console.debug(
                "Artifact-sets | Найдены определения наборов:",
                artifactSetDefinitions.map(item => ({
                    name: item.name,
                    uuid: item.uuid
                }))
            );
        }

        return artifactSetDefinitions;
    })();

    try {
        return await artifactSetDefinitionsPromise;
    } finally {
        artifactSetDefinitionsPromise = null;
    }
}

function artifactSetsInvalidateArtifactSetDefinitions() {
    artifactSetDefinitions = null;
    artifactSetDefinitionsPromise = null;
}


/* =========================================================
   ИДЕНТИФИКАЦИЯ ТРЕБУЕМЫХ ПРЕДМЕТОВ
========================================================= */

function artifactSetsGetSourceUuid(item) {
    return (
        item.flags?.core?.sourceId ??
        item._stats?.compendiumSource ??
        null
    );
}

function artifactSetsItemMatchesRequired(actorItem, required) {
    if (!actorItem || !required?.uuid) return false;

    // 1. Точное совпадение UUID.
    if (actorItem.uuid === required.uuid) {
        return true;
    }

    // 2. Совпадение по стандартному UUID источника Foundry.
    if (artifactSetsGetSourceUuid(actorItem) === required.uuid) {
        return true;
    }

    // 3. Совпадение по флагу Artifact-sets.
    return actorItem.getFlag(
        ARTIFACT_SETS_MODULE_ID,
        "artifactSourceUuid"
    ) === required.uuid;
}


/**
 * Восстанавливает связь между предметом персонажа и исходным предметом.
 *
 * Это нужно для предметов, перенесённых в инвентарь, у которых Foundry
 * не сохранил UUID исходного документа.
 *
 * Автоматическая связь назначается только при единственном кандидате
 * с совпадающими типом и названием.
 */
async function artifactSetsRestoreArtifactSourceUuids(actor, definitions) {
    if (!game.user?.isGM) return;

    const sourceCache = new Map();

    for (const definition of definitions) {
        const config = definition.getFlag(
            ARTIFACT_SETS_MODULE_ID,
            ARTIFACT_SETS_CONFIG_FLAG
        );

        const requiredItems = config?.requiredItems ?? [];

        for (const required of requiredItems) {
            if (!required?.uuid) continue;

            let sourceItem;

            if (sourceCache.has(required.uuid)) {
                sourceItem = sourceCache.get(required.uuid);
            } else {
                sourceItem = await fromUuid(required.uuid);
                sourceCache.set(required.uuid, sourceItem ?? null);
            }

            if (
                !sourceItem ||
                sourceItem.documentName !== "Item"
            ) {
                continue;
            }

            const candidates = actor.items.filter(item =>
                item.type === sourceItem.type &&
                item.name === sourceItem.name
            );

            // Не назначаем источник, если название неоднозначно.
            if (candidates.length !== 1) continue;

            const actorItem = candidates[0];

            const existingSource = actorItem.getFlag(
                ARTIFACT_SETS_MODULE_ID,
                "artifactSourceUuid"
            );

            // Не перезаписываем другую подтверждённую связь.
            if (
                existingSource &&
                existingSource !== required.uuid
            ) {
                continue;
            }

            // Не перезаписываем известный источник Foundry,
            // если он указывает на другой предмет.
            const coreSource = artifactSetsGetSourceUuid(actorItem);

            if (
                coreSource &&
                coreSource !== required.uuid
            ) {
                continue;
            }

            if (existingSource !== required.uuid) {
                await actorItem.setFlag(
                    ARTIFACT_SETS_MODULE_ID,
                    "artifactSourceUuid",
                    required.uuid
                );
            }
        }
    }
}

function artifactSetsHasRequiredArtifacts(actor, requiredItems) {
    if (
        !Array.isArray(requiredItems) ||
        requiredItems.length === 0
    ) {
        return false;
    }

    return requiredItems.every(required => {
        const matchingItem = actor.items.find(item =>
            artifactSetsItemMatchesRequired(item, required)
        );

        if (!matchingItem) return false;

        const attunement = matchingItem.system?.attunement;
        const attuned = matchingItem.system?.attuned;

        const requiresAttunement =
            attunement === true ||
            attunement === "required" ||
            attunement === 2;

        if (!requiresAttunement) {
            return true;
        }

        // Поддерживаем распространённые представления состояния настройки.
        return (
            attuned === true ||
            attuned === 1 ||
            attuned === "attuned"
        );
    });
}

function artifactSetsGetAutoGrantedFeatures(actor, featureUuid) {
    return actor.items.filter(item => {
        if (item.type !== "feat") return false;

        const marker = item.getFlag(
            ARTIFACT_SETS_MODULE_ID,
            ARTIFACT_SETS_GRANTED_FLAG
        );

        return marker?.sourceUuid === featureUuid;
    });
}

/* =========================================================
   УДАЛЕНИЕ АВТОМАТИЧЕСКИХ ОСОБЕННОСТЕЙ
========================================================= */

async function artifactSetsDeleteAutoGrantedFeatures(actor, features) {
    if (!actor || !features?.length) return;

    const idsToDelete = [
        ...new Set(
            features
                .map(item => item.id)
                .filter(id => id && actor.items.has(id))
        )
    ];

    if (!idsToDelete.length) return;

    try {
        await actor.deleteEmbeddedDocuments("Item", idsToDelete);
    } catch (error) {
        const remainingIds = idsToDelete.filter(id =>
            actor.items.has(id)
        );

        // Если документы уже удалены, повторная попытка не нужна.
        if (!remainingIds.length) return;

        console.error(
            `Artifact-sets | Не удалось удалить автоматические особенности персонажа ${actor.name}:`,
            error
        );
    }
}


/* =========================================================
   ОДИН ПРОХОД СИНХРОНИЗАЦИИ
========================================================= */

async function artifactSetsSyncArtifactSetsOnce(actor) {
    const definitions = await artifactSetsGetArtifactSetDefinitions();

    await artifactSetsRestoreArtifactSourceUuids(actor, definitions);

    for (const definition of definitions) {
        const featureUuid = definition.uuid;

        const config = definition.getFlag(
            ARTIFACT_SETS_MODULE_ID,
            ARTIFACT_SETS_CONFIG_FLAG
        );

        const requiredItems = config?.requiredItems ?? [];

        const qualifies =
            requiredItems.length > 0 &&
            artifactSetsHasRequiredArtifacts(actor, requiredItems);

        if (ARTIFACT_SETS_DEBUG) {
            console.debug("Artifact-sets | Проверка набора:", {
                feature: definition.name,
                requiredCount: requiredItems.length,
                qualifies,
                requiredItems: requiredItems.map(required => ({
                    name: required.name,
                    uuid: required.uuid,
                    found: actor.items.some(item =>
                        artifactSetsItemMatchesRequired(item, required)
                    )
                }))
            });
        }

        let autoGranted = artifactSetsGetAutoGrantedFeatures(
            actor,
            featureUuid
        );

        // Если условия больше не выполнены, удаляем только
        // особенности, которые были выданы самим модулем.
        if (!qualifies) {
            await artifactSetsDeleteAutoGrantedFeatures(actor, autoGranted);
            continue;
        }

        // Удаляем лишние автоматически выданные копии.
        if (autoGranted.length > 1) {
            await artifactSetsDeleteAutoGrantedFeatures(
                actor,
                autoGranted.slice(1)
            );

            autoGranted = artifactSetsGetAutoGrantedFeatures(
                actor,
                featureUuid
            );
        }

        // Особенность уже выдана — повторно её не создаём.
        if (autoGranted.length) continue;

        // Если особенность уже добавлена вручную, не создаём копию.
        const manuallyAdded = actor.items.some(item => {
            if (item.type !== "feat") return false;

            const marker = item.getFlag(
                ARTIFACT_SETS_MODULE_ID,
                ARTIFACT_SETS_GRANTED_FLAG
            );

            if (marker?.sourceUuid === featureUuid) {
                return false;
            }

            return artifactSetsGetSourceUuid(item) === featureUuid;
        });

        if (manuallyAdded) continue;

        const pendingKey = `${actor.uuid ?? actor.id}:${featureUuid}`;

        if (artifactSetPending.has(pendingKey)) continue;

        artifactSetPending.add(pendingKey);

        try {
            // Повторная проверка перед созданием защищает от дубликатов.
            if (
                artifactSetsGetAutoGrantedFeatures(actor, featureUuid).length
            ) {
                continue;
            }

            // Перепроверяем актуальные требования набора.
            const latestConfig = definition.getFlag(
                ARTIFACT_SETS_MODULE_ID,
                ARTIFACT_SETS_CONFIG_FLAG
            );

            const latestRequiredItems =
                latestConfig?.requiredItems ?? [];

            if (
                !latestRequiredItems.length ||
                !artifactSetsHasRequiredArtifacts(actor, latestRequiredItems)
            ) {
                continue;
            }

            const featureData = definition.toObject();

            delete featureData._id;

            foundry.utils.setProperty(
                featureData,
                `flags.${ARTIFACT_SETS_MODULE_ID}.${ARTIFACT_SETS_GRANTED_FLAG}`,
                { sourceUuid: featureUuid }
            );

            await actor.createEmbeddedDocuments(
                "Item",
                [featureData]
            );

            if (ARTIFACT_SETS_DEBUG) {
                console.debug(
                    `Artifact-sets | Выдана особенность "${definition.name}" персонажу "${actor.name}".`
                );
            }
        } finally {
            artifactSetPending.delete(pendingKey);
        }
    }
}


/* =========================================================
   ПОСЛЕДОВАТЕЛЬНАЯ СИНХРОНИЗАЦИЯ
========================================================= */

async function artifactSetsSyncArtifactSets(actor) {
    // Только Мастер изменяет предметы и особенности персонажей.
    if (!game.user?.isGM) return;

    if (!actor || actor.type !== "character") return;

    const lockKey = actor.uuid ?? actor.id;

    // Если синхронизация уже идёт, запрашиваем повторный проход.
    if (artifactSetSyncing.has(lockKey)) {
        artifactSetRerun.add(lockKey);
        return;
    }

    artifactSetSyncing.add(lockKey);

    try {
        do {
            artifactSetRerun.delete(lockKey);

            try {
                await artifactSetsSyncArtifactSetsOnce(actor);
            } catch (error) {
                console.error(
                    `Artifact-sets | Ошибка синхронизации наборов артефактов персонажа ${actor.name}:`,
                    error
                );
            }
        } while (artifactSetRerun.has(lockKey));
    } finally {
        artifactSetSyncing.delete(lockKey);

        // Не теряем повторный запрос, возникший на завершении прохода.
        if (artifactSetRerun.has(lockKey)) {
            artifactSetRerun.delete(lockKey);
            void artifactSetsSyncArtifactSets(actor);
        }
    }
}

async function artifactSetsSyncAllCharacterArtifactSets() {
    if (!game.user?.isGM) return;

    for (const actor of game.actors.contents) {
        if (actor.type === "character") {
            await artifactSetsSyncArtifactSets(actor);
        }
    }
}


/* =========================================================
   СОБЫТИЯ FOUNDRY
========================================================= */

// При закрытии листа отключаем observer и освобождаем его связь с окном.
const artifactSetsCloseArtifactSetEditor = app => {
    artifactSetEditorObservers.get(app)?.disconnect();
    artifactSetEditorObservers.delete(app);
};

Hooks.on("closeItemSheet5e", artifactSetsCloseArtifactSetEditor);
Hooks.on("closeItemSheet", artifactSetsCloseArtifactSetEditor);


// Изменения предметов вне листов персонажей могут затрагивать
// определения наборов в мире.
Hooks.on("createItem", item => {
    if (item.parent?.type !== "character") {
        artifactSetsInvalidateArtifactSetDefinitions();
    }
});

Hooks.on("updateItem", item => {
    if (item.parent?.type !== "character") {
        artifactSetsInvalidateArtifactSetDefinitions();
    }
});

Hooks.on("deleteItem", item => {
    if (item.parent?.type !== "character") {
        artifactSetsInvalidateArtifactSetDefinitions();
    }
});


// Изменения предметов персонажа запускают пересчёт набора.
Hooks.on("createItem", item => {
    if (item.parent?.type === "character") {
        void artifactSetsSyncArtifactSets(item.parent);
    }
});

Hooks.on("updateItem", item => {
    if (item.parent?.type === "character") {
        void artifactSetsSyncArtifactSets(item.parent);
    }
});

Hooks.on("deleteItem", item => {
    if (item.parent?.type === "character") {
        void artifactSetsSyncArtifactSets(item.parent);
    }
});


// Первичная синхронизация после готовности мира.
Hooks.once("ready", () => {
    void artifactSetsSyncAllCharacterArtifactSets();
});