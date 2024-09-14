import { mkdir, readdir, stat, readFile, writeFile } from 'node:fs/promises';
import * as assert from "node:assert";
import * as process from "node:process";
import * as path from 'path';
import { JSDOM } from 'jsdom';

type NoteAndName = { note: string; name: string; };
type PreferredOrderGrouping = { key: string; order: number; notes: string[] };

if (process.argv.length < 3) {
    console.error('Usage: yarn run convert-drm <input_directory> <should_use_preferred_grouping>');
    process.exit(1);
}
const baseInputDir = process.argv[2];
const usePreferredGrouping = process.argv[3] ?? false;
const baseOutputDir = path.join(baseInputDir, '../', `${path.basename(baseInputDir)} - output`);

console.log(`baseInputDir: ${baseInputDir}\nbaseOutputDir: ${baseOutputDir}\nusePreferredGrouping: ${usePreferredGrouping}`);

const PREFERRED_ORDERS = [
    'hat',
    'kick',
    'kick 2',
    'kick 1',
    'snare',
    'crash 3',
    'crash 2',
    'crash 1',
    'crash',
    'ride',
    'ride 3',
    'ride 2',
    'ride 1',
    'splash 2',
    'splash 1',
    'splash',
    'cymbal 4',
    'cymbal 3',
    'cymbal 2',
    'cymbal 1',
    'cymbal',
    'racktom 4',
    'racktom 3',
    'racktom 2',
    'racktom 1',
    'racktom',
    'floortom 4',
    'floortom 3',
    'floortom 2',
    'floortom 1',
    'floortom',
].reverse();
/**
 * Scan a directory for .drm drum map files, and convert all of them into the .txt format needed for
 * Cockos REAPER MIDI window Piano roll note/CC names.
 */
async function scanForDrumMapFiles(inputDir: string, outputDir: string) {
    const files = await readdir(inputDir);
    try {
        await stat(outputDir);
        console.debug(`\toutput dir found at "${outputDir}"`);
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            console.warn(`\tcreating output directory "${outputDir}"`);
            await mkdir(outputDir, { recursive: true });
        }
    }
    for (const file of files) {
        const filePath = path.join(inputDir, file);
        const statResult = await stat(filePath);

        if (statResult.isDirectory()) {
            const subDirOutputDirectory = path.join(outputDir, path.basename(filePath));
            await scanForDrumMapFiles(filePath, subDirOutputDirectory);
        } else if (path.extname(file) === '.drm'/* && file.includes('Hell')*/) {
            const outputFile = path.join(outputDir, `${path.basename(file, '.drm')}.txt`);
            try {
                console.debug(`\t\tConverting "${filePath}" to "${outputFile}"`);
                const convertedContent = await convertDRMFileToText(filePath);
                await writeFile(outputFile, convertedContent);
            } catch (error) {
                console.error(error);
            }
        }
    }
}
const groupByPreferred = (notesAndNames: NoteAndName[]) => {
    const groups = notesAndNames.reduce((allGroups, { note, name }) => {
        const curGroup = name.match(/\[(.*)]/);
        if (!curGroup) return allGroups;

        const curGroupKey = curGroup[0];
        const curGroupKeyLower = curGroupKey.toLowerCase();
        let group = allGroups.find(({ key }) => key === curGroupKey);
        if (!group) {
            // console.debug(`group: ${curGroupKeyLower}\tcurGroupKey: ${curGroupKey}`);
            const preferredOrder = PREFERRED_ORDERS
                .findIndex(instrument => {
                    const instWithoutNum = instrument.replaceAll(/(\d+)/g, '').toLowerCase();
                    // console.debug(`\tinstWithoutNum: ${instWithoutNum}`);
                    const hasInstName = curGroupKeyLower.includes(instWithoutNum);
                    let found = false;

                    if (hasInstName) {
                        const instOnlyNum = instrument.match(/(\d+)/)?.[0];
                        const curGroupKeyInstNumber = curGroupKey.match(/(\d+)/)?.[0];
                        // console.debug(curGroupKeyInstNumber);
                        // console.debug(`\t\tinstOnlyNum: ${instOnlyNum}\tcurGroupKeyInstNumber: ${curGroupKeyInstNumber}`);

                        if (instWithoutNum.length === instrument.length) found = true;
                        else if (curGroupKeyInstNumber === instOnlyNum) found = true;
                    }

                    return found;
                });
            // console.debug(`\tpreferredOrder index: ${preferredOrder}`);
            group = { key: curGroupKey, notes: [], order: preferredOrder };
            allGroups.push(group);
        }
        group.notes.push(note);

        return allGroups;
    }, [] as PreferredOrderGrouping[]);

    // Reaper note order is reversed ie the first entry shows up at the BOTTOM of the piano roll, last at the TOP
    // We want to show values we can't group LAST (at the bottom).
    groups.sort((a, b) => {
        if (a.order === -1) return -1;
        if (b.order === -1) return 1;
        if (a.order > b.order) return 1;
        if (a.order < b.order) return -1;
        return 0;
    });

    return groups.reduce((order, group) => {
        order.push(...group.notes.map(note => `NO ${note}`));
        return order;
    }, [] as string[]);
};

/**
 * Convert DRM file XML into text format supported by Cockos REAPER for the MIDI window Piano roll note/CC names.
 */
async function convertDRMFileToText(filePath: string) {
    const drmFileContent = await readFile(filePath, 'utf-8');
    const drmFileDOM = new JSDOM(drmFileContent, { contentType: 'application/xml' });
    const drumMap = drmFileDOM.window.document.children[0];

    const headerName = drumMap.querySelector(':root > string')?.getAttribute('value');
    const mapList = drumMap.querySelectorAll(':root > list[name="Map"][type="list"] > item');

    // Convert the XML values into an array where each item contains the note and name
    const notesAndNames = [...mapList].reduce((filteredNotesAndNames, entry) => {
        const name = entry.querySelector('string[name="Name"]')?.getAttribute('value') ?? '';
        const note = entry.querySelector('int[name="INote"]')?.getAttribute('value') ?? '';

        if (name.length === 0 || note.length === 0) return filteredNotesAndNames;

        filteredNotesAndNames.push({ note, name });
        return filteredNotesAndNames;
    }, [] as NoteAndName[]);

    const orderItems = usePreferredGrouping
        ? groupByPreferred(notesAndNames)
        : [...drumMap.querySelectorAll(':root > list[name="Order"][type="int"] > item')]
            .reduce((filteredOrderItems, entry) => {
                const orderValue = entry.getAttribute('value');
                if (!notesAndNames.find(({ note }) => note === orderValue)) return filteredOrderItems;

                filteredOrderItems.push(`NO ${orderValue}`);
                return filteredOrderItems;
            }, [] as string[]);

    // If using defined ordering, the number of notes and specified order should be the same
    if (!usePreferredGrouping) assert.equal(orderItems.length, notesAndNames.length);

    const notesAndNamesAsStrings = notesAndNames.map(({ note, name}) => `${note} ${name}`);

    return `# ${headerName}
${notesAndNamesAsStrings.join('\n')}
# Grouped order
${orderItems.join('\n')}
`;
}

try {
    await scanForDrumMapFiles(baseInputDir, baseOutputDir);
} catch (error: any) {
    console.error('Error:', error.message);
    process.exit(1);
}
