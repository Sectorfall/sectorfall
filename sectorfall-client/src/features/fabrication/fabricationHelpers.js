export function buildFabricationIngredientPayload(ingredients) {
    return (Array.isArray(ingredients) ? ingredients : [])
        .map(({ item, amount, source }) => ({
            itemId: item?.id,
            amount,
            source
        }))
        .filter(entry => entry.itemId && Number(entry.amount) > 0);
}

export function resolveFabricationBlueprintId(blueprintData) {
    return (
        blueprintData?.canonical_blueprint_id ||
        blueprintData?.canonicalBlueprintId ||
        blueprintData?.item_type ||
        blueprintData?.item_id ||
        blueprintData?.blueprintId ||
        blueprintData?.id ||
        null
    );
}

export function getFabricationErrorMessage(errorCode) {
    const reasonMap = {
        not_docked: 'FABRICATION FAILED: You must be docked.',
        wrong_starport: 'FABRICATION FAILED: Wrong starport context.',
        missing_blueprint_instance: 'FABRICATION FAILED: Missing blueprint instance.',
        blueprint_not_found: 'FABRICATION FAILED: Blueprint item not found.',
        blueprint_definition_missing: 'FABRICATION FAILED: Blueprint definition missing.',
        blueprint_recipe_missing: 'FABRICATION FAILED: Blueprint recipe missing.',
        ingredients_missing: 'FABRICATION FAILED: No ingredients selected.',
        ingredient_not_found: 'FABRICATION FAILED: Selected ingredient not found.',
        insufficient_ingredient_amount: 'FABRICATION FAILED: Insufficient ingredient amount.',
        invalid_ingredient_type: 'FABRICATION FAILED: Invalid ingredient type.',
        recipe_not_satisfied: 'FABRICATION FAILED: Recipe requirements not met.',
        blueprint_consume_failed: 'FABRICATION FAILED: Blueprint consume failed.',
        ingredient_consume_failed: 'FABRICATION FAILED: Ingredient consume failed.',
        ship_definition_missing: 'FABRICATION FAILED: Ship definition missing.',
        module_definition_missing: 'FABRICATION FAILED: Module definition missing.',
        fabrication_failed: 'FABRICATION FAILED: Internal fabrication error.'
    };

    return reasonMap[errorCode] || 'FABRICATION FAILED: Internal fabrication error.';
}

export function getFabricationSuccessMessage(result, blueprintData, avgQL) {
    const craftedName = result?.output?.name || blueprintData?.outputId || 'Fabricated Item';
    const craftedQl = Number(result?.avgQL || avgQL || 0).toFixed(1);

    if (result?.output && result.output.isShip) {
        return `Vessel Fabrication Complete: ${craftedName} [QL ${craftedQl}]`;
    }

    return `Hardware Fabrication Complete: ${craftedName} [QL ${craftedQl}]`;
}

export function getRefineryErrorMessage(code) {
    const errorMap = {
        not_docked: 'STARPORT REFINERY UNAVAILABLE',
        wrong_starport: 'REFINING FAILED: Wrong starport context.',
        missing_item: 'SELECTED ORE STACK NOT FOUND',
        selected_item_not_found: 'SELECTED ORE STACK NOT FOUND',
        invalid_resource: 'SELECTED ORE STACK NOT FOUND',
        storage_capacity: 'STARPORT STORAGE BAY AT CAPACITY',
        invalid_refine_amount: 'REFINING FAILED: Ore stack too small.',
        persist_failed: 'REFINING FAILED: Persistence layer rejected the update.',
        timeout: 'REFINING FAILED: Backend timeout.'
    };

    return errorMap[code] || 'REFINING FAILED';
}
