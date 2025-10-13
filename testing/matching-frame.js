const { useEffect, useMemo, useRef, useState, useCallback } = React;

const COLORS = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000', '#aaffc3', '#808000', '#ffd8b1', '#000075', '#808080', '#ffffff', '#000000'];


const Display = ({ result }) => {
    const { queryImages, allPickedKeyframes, allTrackResults, dimensions, allWorldMatrices, allBeforeProjected, allAfterProjected, projectionMatrix } = result;
    const [trackType, setTrackType] = useState('none');
    const [keyframeIndex, setKeyframeIndex] = useState(0);
    const [queryIndex, setQueryIndex] = useState(0);
    const [planeParams, setPlaneParams] = useState(null);
    const canvasContainerRef = useRef(null);
    const resultContainerRef = useRef(null);
    const canvas2Ref = useRef(null);

    useEffect(() => {
        const firstQueryImage = result.queryImages[0];
        const { dimensions, projectionMatrix, allWorldMatrices } = result;
        const [markerWidth, markerHeight] = dimensions[0];
        const inputHeight = firstQueryImage.height;
        const inputWidth = firstQueryImage.width;

        const proj = projectionMatrix;
        const fov = 2 * Math.atan(1 / proj[5] / inputHeight * inputHeight) * 180 / Math.PI; // vertical fov
        const near = proj[14] / (proj[10] - 1.0);
        const far = proj[14] / (proj[10] + 1.0);
        const ratio = proj[5] / proj[0]; // (r-l) / (t-b)
        const newAspect = inputWidth / inputHeight;

        const camera = new THREE.PerspectiveCamera();
        camera.fov = fov;
        camera.aspect = newAspect;
        camera.near = near;
        camera.far = far;
        camera.updateProjectionMatrix();

        const scene = new THREE.Scene();
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        position.x = markerWidth / 2;
        position.y = markerWidth / 2 + (markerHeight - markerWidth) / 2;
        scale.x = markerWidth;
        scale.y = markerWidth;
        scale.z = markerWidth;
        let postMatrix = new THREE.Matrix4();
        postMatrix.compose(position, quaternion, scale);


        const geometry = new THREE.PlaneGeometry(1, markerHeight / markerWidth);
        const material = new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.6 });
        const plane = new THREE.Mesh(geometry, material);
        scene.add(plane);
        plane.matrixAutoUpdate = false;

        const canvas2 = document.createElement("canvas");
        canvas2.width = inputWidth;
        canvas2.height = inputHeight;
        const renderer = new THREE.WebGLRenderer({ alpha: true, canvas: canvas2 });

        for (let queryIndex = 0; queryIndex < result.queryImages.length; queryIndex++) {
            const queryImage = result.queryImages[queryIndex];

            const worldMatrix = Object.assign({}, allWorldMatrices[queryIndex]);
            var m = new THREE.Matrix4();
            m.elements = worldMatrix;
            m.multiply(postMatrix);
            plane.matrix = m;
            renderer.render(scene, camera);

            const canvasImage = document.createElement("img");
            canvasImage.src = canvas2.toDataURL();

            const container = document.createElement("div");
            container.appendChild(queryImage);
            container.appendChild(canvasImage);
            resultContainerRef.current.appendChild(container);
        }
    }, []);

    return (
        <div>
            <div className="result-container" ref={resultContainerRef}>
            </div>
        </div>
    )
}
const process = async (images, mind) => {
    const targetIndex = 0;
    const queryImages = [];
    for (var i = 0; i < images.length; i++) {
        queryImages.push(await utils.loadImage(images[i]));
    }

    const queryImage0 = queryImages[0];

    const inputWidth = queryImage0.width;
    const inputHeight = queryImage0.height;
    const controller = new MINDAR.Controller({
        inputWidth, inputHeight, debugMode: true,
        frameDetection: { top: 0.2, bottom: 0.2, left: 0.2, right: 0.2 }
    });
    const { dimensions, matchingDataList, trackingDataList } = await controller.addImageTargets(mind);

    const allWorldMatrices = [];
    const debugExtras = [];
    for (let i = 0; i < queryImages.length; i++) {
        const queryImage = queryImages[i];
        const { featurePoints } = await controller.detect(queryImage);
        const { modelViewTransform, debugExtra } = await controller.match(featurePoints, targetIndex);
        if (modelViewTransform) {
            allWorldMatrices.push(controller.getWorldMatrix(modelViewTransform, targetIndex));
            debugExtras.push(debugExtra);
        } else {
            allWorldMatrices.push(null);
        }
    }

    const projectionMatrix = controller.getProjectionMatrix();

    const result = {
        queryImages,
        dimensions,
        allWorldMatrices,
        debugExtras,
        projectionMatrix,
    }
    return result;
}

const Test = (params) => {
    const [result, setResult] = useState();
    const { images, mind } = params;
    useEffect(async () => {
        setResult(await process(images, mind));
    }, []);

    console.log("result", result);

    return (
        <div className="tracking">
            {result && <Display result={result} />}
            {!result && <div>Loading...</div>}

        </div>
    )
};
var i = 1

var images = [
    'targets/target_frame_only.jpg',
    "targets/frame_with_cloud_rot.jpg",
    "targets/frame_with_checker_white_rot.jpg",
    "targets/frame_with_people_rot.jpg",
    "targets/frame_with_squares_rot.jpg",
    'targets/frame_with_dog.jpg',
];
var mind = 'targets/target_frame_only.mind'

ReactDOM.render(
    <Test images={images} mind={mind} />,
    document.getElementById('test' + (i++))
);

var images = [
    'targets/target_dog.jpg',
    "targets/frame_with_cloud_rot.jpg",
    "targets/frame_with_checker_white_rot.jpg",
    "targets/frame_with_people_rot.jpg",
    "targets/frame_with_squares_rot.jpg",
    'targets/frame_with_dog.jpg',
];
var mind = 'targets/target_dog.mind';

ReactDOM.render(
    <Test images={images} mind={mind} />,
    document.getElementById('test' + (i++))
);

var images = [
    'targets/target_frame_rays_border.jpg',
    "targets/frame_rays_with_cloud.jpg",
    "targets/frame_rays_with_cloud_rot.jpg",
    "targets/frame_rays_with_people.jpg",
    "targets/frame_rays_tr_with_cloud.jpg",
];
var mind = 'targets/target_frame_rays_border.mind';

ReactDOM.render(
    <Test images={images} mind={mind} />,
    document.getElementById('test' + (i++))
);

var images = [
    'targets/target_white_frame.jpg',
    "targets/white_frame_black.jpg",
    "targets/white_frame_black_rot.jpg",
    "targets/white_frame_with_cloud_rot.jpg",
    "targets/white_frame_with_cloud_contrast.jpg",
    "targets/white_frame_with_people_rot.jpg",
];
var mind = 'targets/target_white_frame.mind';

ReactDOM.render(
    <Test images={images} mind={mind} />,
    document.getElementById('test' + (i++))
);

