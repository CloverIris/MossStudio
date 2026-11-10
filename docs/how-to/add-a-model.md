---
status: current
last-verified: 2026-11-10 (ae28573)
code: apps/desktop/resources/models.json, apps/desktop/src/shared/modelCatalog.ts, apps/desktop/src/main/services/models.ts, .github/workflows/catalog.yml
---

# Add a model without a release

Released apps read the model catalog from `main`, so a model is added by a pull request that edits `apps/desktop/resources/models.json`. It reaches every app within minutes of the merge, with no new version.
This page covers the steps and the two fields that keep an older app from offering what it cannot run. How the app picks and checks the catalog is in [models.md](/docs/reference/models.md#1-catalog-components-and-bundles).

## Before you start

The engine must load the model. Check the MossInfer [supported models](https://github.com/mossimage-cpp/mossimage.cpp#supported-models). A model the engine cannot load needs an engine release first, and the catalog cannot express that.

## Steps

1. **Add each new part to `models`.** Copy a similar entry and change it:
   - `id`: lowercase, unique, never reused for different files.
   - `repo` and `revision`: the Hugging Face repository and the full 40-character commit the files were tested at. `main` is accepted but follows whatever is pushed next.
   - `role`: `dit`, `text_encoder`, `vae` or `support`.
   - `files`, `subfolder` and `format` (`comfyui` for one `.safetensors` file, `diffusers` for a folder).
   - `size_bytes`: the exact total of `files`. `https://huggingface.co/api/models/<repo>/tree/<revision>?recursive=1` lists each file's size.

   Reuse a part that is already listed, such as `qwen35-comfy-int8_convrot` or `moss-runtime-config`, instead of adding it twice.
2. **Add the model to a bundle list.** A model made of single weight files goes in `single_file_bundles`; a diffusers folder model goes in `bundles`. The bundle names its `dit`, `textEncoder`, `vae` and `support` parts by id. The bundle fields are described in [models.md](/docs/reference/models.md#1-catalog-components-and-bundles).
3. **Set `min_app_version` if older apps cannot use it.** Do this when the model needs app code that is not in every released version, such as a new bundle field or tier. Use the first version that has that code, for example `"2.1.0"`. Leave it out when every supported version can run the model.
4. **Set `updated_at`** to the current time (ISO 8601, UTC).
5. **Check the file:** `pnpm test:unit -- test/shared/modelCatalog.test.ts`. It reports each problem on one line, such as a bundle naming a part that does not exist or a revision that is not a commit.
6. **Try it:** run `pnpm dev`. In development the app reads `models.json` from the source tree, so the model shows on the 模型 page at once. Download it and generate one image.
7. **Open a pull request** titled like `feat(models): add MOSS-Image SFT W4A8`, and merge it through the merge queue. CI runs the same check.

After the merge, `.github/workflows/catalog.yml` clears jsDelivr's copy. Apps see the model the next time they refresh the catalog, for example when the 模型 page opens.

## Changing the file's layout

Leave `schema_version` at 3 when you add fields: older apps ignore fields they do not know. Raise it only when an older app would misread the file. Such an app then keeps its saved or packaged catalog and no longer sees new models, so raise `CATALOG_SCHEMA_VERSION` in `shared/modelCatalog.ts` in the same release, and expect old versions to stop getting new models.
